/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 * vim: set ts=8 sts=4 et sw=4 tw=99:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "proxy/ScriptedDirectProxyHandler.h"

#include "jsapi.h"

#include "vm/PropDesc.h"

#include "jsobjinlines.h"

using namespace js;
using mozilla::ArrayLength;

static inline bool
IsDataDescriptor(const PropertyDescriptor &desc)
{
    return desc.obj && !(desc.attrs & (JSPROP_GETTER | JSPROP_SETTER));
}

static inline bool
IsAccessorDescriptor(const PropertyDescriptor &desc)
{
    return desc.obj && desc.attrs & (JSPROP_GETTER | JSPROP_SETTER);
}

// ES6 (5 April 2014) ValidateAndApplyPropertyDescriptor(O, P, Extensible, Desc, Current)
// Since we are actually performing 9.1.6.2 IsCompatiblePropertyDescriptor(Extensible, Desc,
// Current), some parameters are omitted.
static bool
ValidatePropertyDescriptor(JSContext *cx, bool extensible, Handle<PropDesc> desc,
                           Handle<PropertyDescriptor> current, bool *bp)
{
    // step 2
    if (!current.object()) {
        // Since |O| is always undefined, substeps c and d fall away.
        *bp = extensible;
        return true;
    }

    // step 3
    if (!desc.hasValue() && !desc.hasWritable() && !desc.hasGet() && !desc.hasSet() &&
        !desc.hasEnumerable() && !desc.hasConfigurable())
    {
        *bp = true;
        return true;
    }

    // step 4
    if ((!desc.hasWritable() || desc.writable() == !current.isReadonly()) &&
        (!desc.hasGet() || desc.getter() == current.getter()) &&
        (!desc.hasSet() || desc.setter() == current.setter()) &&
        (!desc.hasEnumerable() || desc.enumerable() == current.isEnumerable()) &&
        (!desc.hasConfigurable() || desc.configurable() == !current.isPermanent()))
    {
        if (!desc.hasValue()) {
            *bp = true;
            return true;
        }
        bool same = false;
        if (!SameValue(cx, desc.value(), current.value(), &same))
            return false;
        if (same) {
            *bp = true;
            return true;
        }
    }

    // step 5
    if (current.isPermanent()) {
        if (desc.hasConfigurable() && desc.configurable()) {
            *bp = false;
            return true;
        }

        if (desc.hasEnumerable() &&
            desc.enumerable() != current.isEnumerable())
        {
            *bp = false;
            return true;
        }
    }

    // step 6
    if (desc.isGenericDescriptor()) {
        *bp = true;
        return true;
    }

    // step 7a
    if (IsDataDescriptor(current) != desc.isDataDescriptor()) {
        *bp = !current.isPermanent();
        return true;
    }

    // step 8
    if (IsDataDescriptor(current)) {
        MOZ_ASSERT(desc.isDataDescriptor()); // by step 7a
        if (current.isPermanent() && current.isReadonly()) {
            if (desc.hasWritable() && desc.writable()) {
                *bp = false;
                return true;
            }

            if (desc.hasValue()) {
                bool same;
                if (!SameValue(cx, desc.value(), current.value(), &same))
                    return false;
                if (!same) {
                    *bp = false;
                    return true;
                }
            }
        }

        *bp = true;
        return true;
    }

    // step 9
    MOZ_ASSERT(IsAccessorDescriptor(current)); // by step 8
    MOZ_ASSERT(desc.isAccessorDescriptor()); // by step 7a
    *bp = (!current.isPermanent() ||
           ((!desc.hasSet() || desc.setter() == current.setter()) &&
            (!desc.hasGet() || desc.getter() == current.getter())));
    return true;
}

// Aux.6 IsSealed(O, P)
static bool
IsSealed(JSContext* cx, HandleObject obj, HandleId id, bool *bp)
{
    // step 1
    Rooted<PropertyDescriptor> desc(cx);
    if (!GetOwnPropertyDescriptor(cx, obj, id, &desc))
        return false;

    // steps 2-3
    *bp = desc.object() && desc.isPermanent();
    return true;
}

static bool
HasOwn(JSContext *cx, HandleObject obj, HandleId id, bool *bp)
{
    Rooted<PropertyDescriptor> desc(cx);
    if (!JS_GetPropertyDescriptorById(cx, obj, id, &desc))
        return false;
    *bp = (desc.object() == obj);
    return true;
}

// Get the [[ProxyHandler]] of a scripted direct proxy.
static JSObject *
GetDirectProxyHandlerObject(JSObject *proxy)
{
    MOZ_ASSERT(proxy->as<ProxyObject>().handler() == &ScriptedDirectProxyHandler::singleton);
    return proxy->as<ProxyObject>().extra(ScriptedDirectProxyHandler::HANDLER_EXTRA).toObjectOrNull();
}

static inline void
ReportInvalidTrapResult(JSContext *cx, JSObject *proxy, JSAtom *atom)
{
    RootedValue v(cx, ObjectOrNullValue(proxy));
    JSAutoByteString bytes;
    if (!AtomToPrintableString(cx, atom, &bytes))
        return;
    js_ReportValueError2(cx, JSMSG_INVALID_TRAP_RESULT, JSDVG_IGNORE_STACK, v,
                         js::NullPtr(), bytes.ptr());
}

// This function is shared between ownPropertyKeys, enumerate, and
// getOwnEnumerablePropertyKeys.
static bool
ArrayToIdVector(JSContext *cx, HandleObject proxy, HandleObject target, HandleValue v,
                AutoIdVector &props, unsigned flags, JSAtom *trapName_)
{
    MOZ_ASSERT(v.isObject());
    RootedObject array(cx, &v.toObject());
    RootedAtom trapName(cx, trapName_);

    // steps g-h
    uint32_t n;
    if (!GetLengthProperty(cx, array, &n))
        return false;

    // steps i-k
    for (uint32_t i = 0; i < n; ++i) {
        // step i
        RootedValue v(cx);
        if (!JSObject::getElement(cx, array, array, i, &v))
            return false;

        // step ii
        RootedId id(cx);
        if (!ValueToId<CanGC>(cx, v, &id))
            return false;

        // step iii
        for (uint32_t j = 0; j < i; ++j) {
            if (props[j].get() == id) {
                ReportInvalidTrapResult(cx, proxy, trapName);
                return false;
            }
        }

        // step iv
        bool isFixed;
        if (!HasOwn(cx, target, id, &isFixed))
            return false;

        // step v
        bool extensible;
        if (!JSObject::isExtensible(cx, target, &extensible))
            return false;
        if (!extensible && !isFixed) {
            JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_REPORT_NEW);
            return false;
        }

        // step vi
        if (!props.append(id))
            return false;
    }

    // step l
    AutoIdVector ownProps(cx);
    if (!GetPropertyKeys(cx, target, flags, &ownProps))
        return false;

    // step m
    for (size_t i = 0; i < ownProps.length(); ++i) {
        RootedId id(cx, ownProps[i]);

        bool found = false;
        for (size_t j = 0; j < props.length(); ++j) {
            if (props[j].get() == id) {
                found = true;
               break;
            }
        }
        if (found)
            continue;

        // step i
        bool sealed;
        if (!IsSealed(cx, target, id, &sealed))
            return false;
        if (sealed) {
            JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_SKIP_NC);
            return false;
        }

        // step ii
        bool isFixed;
        if (!HasOwn(cx, target, id, &isFixed))
            return false;

        // step iii
        bool extensible;
        if (!JSObject::isExtensible(cx, target, &extensible))
            return false;
        if (!extensible && isFixed) {
            JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_REPORT_E_AS_NE);
            return false;
        }
    }

    // step n
    return true;
}

// ES6 (22 May, 2014) 9.5.4 Proxy.[[PreventExtensions]]()
bool
ScriptedDirectProxyHandler::preventExtensions(JSContext *cx, HandleObject proxy) const
{
    // step 1
    RootedObject handler(cx, GetDirectProxyHandlerObject(proxy));

    // step 2
    if (!handler) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_PROXY_REVOKED);
        return false;
    }

    // step 3
    RootedObject target(cx, proxy->as<ProxyObject>().target());

    // step 4-5
    RootedValue trap(cx);
    if (!JSObject::getProperty(cx, handler, handler, cx->names().preventExtensions, &trap))
        return false;

    // step 6
    if (trap.isUndefined())
        return DirectProxyHandler::preventExtensions(cx, proxy);

    // step 7, 9
    Value argv[] = {
        ObjectValue(*target)
    };
    RootedValue trapResult(cx);
    if (!Invoke(cx, ObjectValue(*handler), trap, ArrayLength(argv), argv, &trapResult))
        return false;

    // step 8
    bool success = ToBoolean(trapResult);
    if (success) {
        // step 10
        bool extensible;
        if (!JSObject::isExtensible(cx, target, &extensible))
            return false;
        if (extensible) {
            JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_REPORT_AS_NON_EXTENSIBLE);
            return false;
        }
        // step 11 "return true"
        return true;
    }

    // step 11 "return false"
    // This actually corresponds to 19.1.2.5 step 4. We cannot pass the failure back, so throw here
    // directly instead.
    JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_CHANGE_EXTENSIBILITY);
    return false;
}

// Corresponds to the "standard" property descriptor getOwn getPrototypeOf dance. It's so explicit
// here because ScriptedDirectProxyHandler allows script visibility for this operation.
bool
ScriptedDirectProxyHandler::getPropertyDescriptor(JSContext *cx, HandleObject proxy, HandleId id,
                                                  MutableHandle<PropertyDescriptor> desc) const
{
    JS_CHECK_RECURSION(cx, return false);

    if (!GetOwnPropertyDescriptor(cx, proxy, id, desc))
        return false;
    if (desc.object())
        return true;
    RootedObject proto(cx);
    if (!JSObject::getProto(cx, proxy, &proto))
        return false;
    if (!proto) {
        MOZ_ASSERT(!desc.object());
        return true;
    }
    return JS_GetPropertyDescriptorById(cx, proto, id, desc);
}

// ES6 (5 April 2014) 9.5.5 Proxy.[[GetOwnProperty]](P)
bool
ScriptedDirectProxyHandler::getOwnPropertyDescriptor(JSContext *cx, HandleObject proxy, HandleId id,
                                                     MutableHandle<PropertyDescriptor> desc) const
{
    // step 2
    RootedObject handler(cx, GetDirectProxyHandlerObject(proxy));

    // step 3
    if (!handler) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_PROXY_REVOKED);
        return false;
    }

    // step 4
    RootedObject target(cx, proxy->as<ProxyObject>().target());

    // step 5-6
    RootedValue trap(cx);
    if (!JSObject::getProperty(cx, handler, handler, cx->names().getOwnPropertyDescriptor, &trap))
        return false;

    // step 7
    if (trap.isUndefined())
        return DirectProxyHandler::getOwnPropertyDescriptor(cx, proxy, id, desc);

    // step 8-9
    RootedValue propKey(cx);
    if (!IdToStringOrSymbol(cx, id, &propKey))
        return false;

    Value argv[] = {
        ObjectValue(*target),
        propKey
    };
    RootedValue trapResult(cx);
    if (!Invoke(cx, ObjectValue(*handler), trap, ArrayLength(argv), argv, &trapResult))
        return false;

    // step 10
    if (!trapResult.isUndefined() && !trapResult.isObject()) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_PROXY_GETOWN_OBJORUNDEF);
        return false;
    }

    //step 11-12
    Rooted<PropertyDescriptor> targetDesc(cx);
    if (!GetOwnPropertyDescriptor(cx, target, id, &targetDesc))
        return false;

    // step 13
    if (trapResult.isUndefined()) {
        // substep a
        if (!targetDesc.object()) {
            desc.object().set(nullptr);
            return true;
        }

        // substep b
        if (targetDesc.isPermanent()) {
            JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_REPORT_NC_AS_NE);
            return false;
        }

        // substep c-e
        bool extensibleTarget;
        if (!JSObject::isExtensible(cx, target, &extensibleTarget))
            return false;
        if (!extensibleTarget) {
            JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_REPORT_E_AS_NE);
            return false;
        }

        // substep f
        desc.object().set(nullptr);
        return true;
    }

    // step 14-15
    bool extensibleTarget;
    if (!JSObject::isExtensible(cx, target, &extensibleTarget))
        return false;

    // step 16-17
    Rooted<PropDesc> resultDesc(cx);
    if (!resultDesc.initialize(cx, trapResult))
        return false;

    // step 18
    resultDesc.complete();

    // step 19
    bool valid;
    if (!ValidatePropertyDescriptor(cx, extensibleTarget, resultDesc, targetDesc, &valid))
        return false;

    // step 20
    if (!valid) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_REPORT_INVALID);
        return false;
    }

    // step 21
    if (!resultDesc.configurable()) {
        if (!targetDesc.object()) {
            JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_REPORT_NE_AS_NC);
            return false;
        }

        if (!targetDesc.isPermanent()) {
            JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_REPORT_C_AS_NC);
            return false;
        }
    }

    // step 22
    resultDesc.populatePropertyDescriptor(proxy, desc);
    return true;
}

// ES6 (5 April 2014) 9.5.6 Proxy.[[DefineOwnProperty]](O,P)
bool
ScriptedDirectProxyHandler::defineProperty(JSContext *cx, HandleObject proxy, HandleId id,
                                           MutableHandle<PropertyDescriptor> desc) const
{
    // step 2
    RootedObject handler(cx, GetDirectProxyHandlerObject(proxy));

    // step 3
    if (!handler) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_PROXY_REVOKED);
        return false;
    }

    // step 4
    RootedObject target(cx, proxy->as<ProxyObject>().target());

    // step 5-6
    RootedValue trap(cx);
    if (!JSObject::getProperty(cx, handler, handler, cx->names().defineProperty, &trap))
         return false;

    // step 7
    if (trap.isUndefined())
        return DirectProxyHandler::defineProperty(cx, proxy, id, desc);

    // step 8-9
    RootedValue descObj(cx);
    if (!NewPropertyDescriptorObject(cx, desc, &descObj))
        return false;

    // step 10, 12
    RootedValue propKey(cx);
    if (!IdToStringOrSymbol(cx, id, &propKey))
        return false;

    Value argv[] = {
        ObjectValue(*target),
        propKey,
        descObj
    };
    RootedValue trapResult(cx);
    if (!Invoke(cx, ObjectValue(*handler), trap, ArrayLength(argv), argv, &trapResult))
        return false;

    // step 11, 13
    if (ToBoolean(trapResult)) {
        // step 14-15
        Rooted<PropertyDescriptor> targetDesc(cx);
        if (!GetOwnPropertyDescriptor(cx, target, id, &targetDesc))
            return false;

        // step 16-17
        bool extensibleTarget;
        if (!JSObject::isExtensible(cx, target, &extensibleTarget))
            return false;

        // step 18-19
        bool settingConfigFalse = desc.isPermanent();
        if (!targetDesc.object()) {
            // step 20a
            if (!extensibleTarget) {
                JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_DEFINE_NEW);
                return false;
            }
            // step 20b
            if (settingConfigFalse) {
                JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_DEFINE_NE_AS_NC);
                return false;
            }
        } else {
            // step 21
            bool valid;
            Rooted<PropDesc> pd(cx);
            pd.initFromPropertyDescriptor(desc);
            if (!ValidatePropertyDescriptor(cx, extensibleTarget, pd, targetDesc, &valid))
                return false;
            if (!valid || (settingConfigFalse && !targetDesc.isPermanent())) {
                JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_DEFINE_INVALID);
                return false;
            }
        }
    }

    // [[DefineProperty]] should return a boolean value, which is used to do things like
    // strict-mode throwing. At present, the engine is not prepared to do that. See bug 826587.
    return true;
}

// ES6 (5 April 2014) 9.5.12 Proxy.[[OwnPropertyKeys]]()
bool
ScriptedDirectProxyHandler::ownPropertyKeys(JSContext *cx, HandleObject proxy,
                                            AutoIdVector &props) const
{
    // step 1
    RootedObject handler(cx, GetDirectProxyHandlerObject(proxy));

    // step 2
    if (!handler) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_PROXY_REVOKED);
        return false;
    }

    // step 3
    RootedObject target(cx, proxy->as<ProxyObject>().target());

    // step 4-5
    RootedValue trap(cx);
    if (!JSObject::getProperty(cx, handler, handler, cx->names().ownKeys, &trap))
        return false;

    // step 6
    if (trap.isUndefined())
        return DirectProxyHandler::ownPropertyKeys(cx, proxy, props);

    // step 7-8
    Value argv[] = {
        ObjectValue(*target)
    };
    RootedValue trapResult(cx);
    if (!Invoke(cx, ObjectValue(*handler), trap, ArrayLength(argv), argv, &trapResult))
        return false;

    // step 9
    if (trapResult.isPrimitive()) {
        ReportInvalidTrapResult(cx, proxy, cx->names().ownKeys);
        return false;
    }

    // Here we add a bunch of extra sanity checks. It is unclear if they will also appear in
    // the spec. See step 10-11
    return ArrayToIdVector(cx, proxy, target, trapResult, props,
                           JSITER_OWNONLY | JSITER_HIDDEN | JSITER_SYMBOLS,
                           cx->names().getOwnPropertyNames);
}

// ES6 (5 April 2014) 9.5.10 Proxy.[[Delete]](P)
bool
ScriptedDirectProxyHandler::delete_(JSContext *cx, HandleObject proxy, HandleId id, bool *bp) const
{
    // step 2
    RootedObject handler(cx, GetDirectProxyHandlerObject(proxy));

    // step 3
    if (!handler) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_PROXY_REVOKED);
        return false;
    }

    // step 4
    RootedObject target(cx, proxy->as<ProxyObject>().target());

    // step 5
    RootedValue trap(cx);
    if (!JSObject::getProperty(cx, handler, handler, cx->names().deleteProperty, &trap))
        return false;

    // step 7
    if (trap.isUndefined())
        return DirectProxyHandler::delete_(cx, proxy, id, bp);

    // step 8
    RootedValue value(cx);
    if (!IdToStringOrSymbol(cx, id, &value))
        return false;
    Value argv[] = {
        ObjectValue(*target),
        value
    };
    RootedValue trapResult(cx);
    if (!Invoke(cx, ObjectValue(*handler), trap, ArrayLength(argv), argv, &trapResult))
        return false;

    // step 9
    if (ToBoolean(trapResult)) {
        // step 12
        Rooted<PropertyDescriptor> desc(cx);
        if (!GetOwnPropertyDescriptor(cx, target, id, &desc))
            return false;

        // step 14-15
        if (desc.object() && desc.isPermanent()) {
            RootedValue v(cx, IdToValue(id));
            js_ReportValueError(cx, JSMSG_CANT_DELETE, JSDVG_IGNORE_STACK, v, js::NullPtr());
            return false;
        }

        // step 16
        *bp = true;
        return true;
    }

    // step 11
    *bp = false;
    return true;
}

// ES6 (22 May, 2014) 9.5.11 Proxy.[[Enumerate]]
bool
ScriptedDirectProxyHandler::enumerate(JSContext *cx, HandleObject proxy, AutoIdVector &props) const
{
    // step 1
    RootedObject handler(cx, GetDirectProxyHandlerObject(proxy));

    // step 2
    if (!handler) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_PROXY_REVOKED);
        return false;
    }

    // step 3
    RootedObject target(cx, proxy->as<ProxyObject>().target());

    // step 4-5
    RootedValue trap(cx);
    if (!JSObject::getProperty(cx, handler, handler, cx->names().enumerate, &trap))
        return false;

    // step 6
    if (trap.isUndefined())
        return DirectProxyHandler::enumerate(cx, proxy, props);

    // step 7-8
    Value argv[] = {
        ObjectOrNullValue(target)
    };
    RootedValue trapResult(cx);
    if (!Invoke(cx, ObjectValue(*handler), trap, ArrayLength(argv), argv, &trapResult))
        return false;

    // step 9
    if (trapResult.isPrimitive()) {
        JSAutoByteString bytes;
        if (!AtomToPrintableString(cx, cx->names().enumerate, &bytes))
            return false;
        RootedValue v(cx, ObjectOrNullValue(proxy));
        js_ReportValueError2(cx, JSMSG_INVALID_TRAP_RESULT, JSDVG_SEARCH_STACK,
                             v, js::NullPtr(), bytes.ptr());
        return false;
    }

    // step 10
    // FIXME: the trap should return an iterator object, see bug 783826. Since this isn't very
    // useful for us internally, we convery to an id vector.
    return ArrayToIdVector(cx, proxy, target, trapResult, props, 0, cx->names().enumerate);
}

// ES6 (22 May, 2014) 9.5.7 Proxy.[[HasProperty]](P)
bool
ScriptedDirectProxyHandler::has(JSContext *cx, HandleObject proxy, HandleId id, bool *bp) const
{
    // step 2
    RootedObject handler(cx, GetDirectProxyHandlerObject(proxy));

    // step 3
    if (!handler) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_PROXY_REVOKED);
        return false;
    }

    // step 4
    RootedObject target(cx, proxy->as<ProxyObject>().target());

    // step 5-6
    RootedValue trap(cx);
    if (!JSObject::getProperty(cx, handler, handler, cx->names().has, &trap))
        return false;

    // step 7
    if (trap.isUndefined())
        return DirectProxyHandler::has(cx, proxy, id, bp);

    // step 8,10
    RootedValue value(cx);
    if (!IdToStringOrSymbol(cx, id, &value))
        return false;
    Value argv[] = {
        ObjectOrNullValue(target),
        value
    };
    RootedValue trapResult(cx);
    if (!Invoke(cx, ObjectValue(*handler), trap, ArrayLength(argv), argv, &trapResult))
        return false;

    // step 9
    bool success = ToBoolean(trapResult);

    // step 11
    if (!success) {
        Rooted<PropertyDescriptor> desc(cx);
        if (!GetOwnPropertyDescriptor(cx, target, id, &desc))
            return false;

        if (desc.object()) {
            if (desc.isPermanent()) {
                JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_REPORT_NC_AS_NE);
                return false;
            }

            bool extensible;
            if (!JSObject::isExtensible(cx, target, &extensible))
                return false;
            if (!extensible) {
                JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_REPORT_E_AS_NE);
                return false;
            }
        }
    }

    // step 12
    *bp = success;
    return true;
}

// ES6 (22 May, 2014) 9.5.8 Proxy.[[GetP]](P, Receiver)
bool
ScriptedDirectProxyHandler::get(JSContext *cx, HandleObject proxy, HandleObject receiver,
                                HandleId id, MutableHandleValue vp) const
{
    // step 2
    RootedObject handler(cx, GetDirectProxyHandlerObject(proxy));

    // step 3
    if (!handler) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_PROXY_REVOKED);
        return false;
    }

    // step 4
    RootedObject target(cx, proxy->as<ProxyObject>().target());

    // step 5-6
    RootedValue trap(cx);
    if (!JSObject::getProperty(cx, handler, handler, cx->names().get, &trap))
        return false;

    // step 7
    if (trap.isUndefined())
        return DirectProxyHandler::get(cx, proxy, receiver, id, vp);

    // step 8-9
    RootedValue value(cx);
    if (!IdToStringOrSymbol(cx, id, &value))
        return false;
    Value argv[] = {
        ObjectOrNullValue(target),
        value,
        ObjectOrNullValue(receiver)
    };
    RootedValue trapResult(cx);
    if (!Invoke(cx, ObjectValue(*handler), trap, ArrayLength(argv), argv, &trapResult))
        return false;

    // step 10-11
    Rooted<PropertyDescriptor> desc(cx);
    if (!GetOwnPropertyDescriptor(cx, target, id, &desc))
        return false;

    // step 12
    if (desc.object()) {
        if (IsDataDescriptor(desc) && desc.isPermanent() && desc.isReadonly()) {
            bool same;
            if (!SameValue(cx, trapResult, desc.value(), &same))
                return false;
            if (!same) {
                JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_MUST_REPORT_SAME_VALUE);
                return false;
            }
        }

        if (IsAccessorDescriptor(desc) && desc.isPermanent() && !desc.hasGetterObject()) {
            if (!trapResult.isUndefined()) {
                JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_MUST_REPORT_UNDEFINED);
                return false;
            }
        }
    }

    // step 13
    vp.set(trapResult);
    return true;
}

// ES6 (22 May, 2014) 9.5.9 Proxy.[[SetP]](P, V, Receiver)
bool
ScriptedDirectProxyHandler::set(JSContext *cx, HandleObject proxy, HandleObject receiver,
                                HandleId id, bool strict, MutableHandleValue vp) const
{
    // step 2
    RootedObject handler(cx, GetDirectProxyHandlerObject(proxy));

    // step 3
    if (!handler) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_PROXY_REVOKED);
        return false;
    }

    // step 4
    RootedObject target(cx, proxy->as<ProxyObject>().target());

    // step 5-6
    RootedValue trap(cx);
    if (!JSObject::getProperty(cx, handler, handler, cx->names().set, &trap))
        return false;

    // step 7
    if (trap.isUndefined())
        return DirectProxyHandler::set(cx, proxy, receiver, id, strict, vp);

    // step 8,10
    RootedValue value(cx);
    if (!IdToStringOrSymbol(cx, id, &value))
        return false;
    Value argv[] = {
        ObjectOrNullValue(target),
        value,
        vp.get(),
        ObjectValue(*receiver)
    };
    RootedValue trapResult(cx);
    if (!Invoke(cx, ObjectValue(*handler), trap, ArrayLength(argv), argv, &trapResult))
        return false;

    // step 9
    bool success = ToBoolean(trapResult);

    if (success) {
        // step 12-13
        Rooted<PropertyDescriptor> desc(cx);
        if (!GetOwnPropertyDescriptor(cx, target, id, &desc))
            return false;

        // step 14
        if (desc.object()) {
            if (IsDataDescriptor(desc) && desc.isPermanent() && desc.isReadonly()) {
                bool same;
                if (!SameValue(cx, vp, desc.value(), &same))
                    return false;
                if (!same) {
                    JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_SET_NW_NC);
                    return false;
                }
            }

            if (IsAccessorDescriptor(desc) && desc.isPermanent() && !desc.hasSetterObject()) {
                JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_CANT_SET_WO_SETTER);
                return false;
            }
        }
    }

    // step 11, 15
    vp.set(BooleanValue(success));
    return true;
}

// ES6 (5 April, 2014) 9.5.3 Proxy.[[IsExtensible]]()
bool
ScriptedDirectProxyHandler::isExtensible(JSContext *cx, HandleObject proxy, bool *extensible) const
{
    // step 1
    RootedObject handler(cx, GetDirectProxyHandlerObject(proxy));

    // step 2
    if (!handler) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_PROXY_REVOKED);
        return false;
    }

    // step 3
    RootedObject target(cx, proxy->as<ProxyObject>().target());

    // step 4-5
    RootedValue trap(cx);
    if (!JSObject::getProperty(cx, handler, handler, cx->names().isExtensible, &trap))
        return false;

    // step 6
    if (trap.isUndefined())
        return DirectProxyHandler::isExtensible(cx, proxy, extensible);

    // step 7, 9
    Value argv[] = {
        ObjectValue(*target)
    };
    RootedValue trapResult(cx);
    if (!Invoke(cx, ObjectValue(*handler), trap, ArrayLength(argv), argv, &trapResult))
        return false;

    // step 8
    bool booleanTrapResult = ToBoolean(trapResult);

    // step 10-11
    bool targetResult;
    if (!JSObject::isExtensible(cx, target, &targetResult))
        return false;

    // step 12
    if (targetResult != booleanTrapResult) {
       JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_PROXY_EXTENSIBILITY);
       return false;
    }

    // step 13
    *extensible = booleanTrapResult;
    return true;
}

bool
ScriptedDirectProxyHandler::iterate(JSContext *cx, HandleObject proxy, unsigned flags,
                                    MutableHandleValue vp) const
{
    // FIXME: Provide a proper implementation for this trap, see bug 787004
    return DirectProxyHandler::iterate(cx, proxy, flags, vp);
}

// ES6 (22 May, 2014) 9.5.13 Proxy.[[Call]]
bool
ScriptedDirectProxyHandler::call(JSContext *cx, HandleObject proxy, const CallArgs &args) const
{
    // step 1
    RootedObject handler(cx, GetDirectProxyHandlerObject(proxy));

    // step 2
    if (!handler) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_PROXY_REVOKED);
        return false;
    }

    // step 3
    RootedObject target(cx, proxy->as<ProxyObject>().target());

    /*
     * NB: Remember to throw a TypeError here if we change NewProxyObject so that this trap can get
     * called for non-callable objects.
     */

    // step 7
    RootedObject argsArray(cx, NewDenseCopiedArray(cx, args.length(), args.array()));
    if (!argsArray)
        return false;

    // step 4-5
    RootedValue trap(cx);
    if (!JSObject::getProperty(cx, handler, handler, cx->names().apply, &trap))
        return false;

    // step 6
    if (trap.isUndefined())
        return DirectProxyHandler::call(cx, proxy, args);

    // step 8
    Value argv[] = {
        ObjectValue(*target),
        args.thisv(),
        ObjectValue(*argsArray)
    };
    RootedValue thisValue(cx, ObjectValue(*handler));
    return Invoke(cx, thisValue, trap, ArrayLength(argv), argv, args.rval());
}

// ES6 (22 May, 2014) 9.5.14 Proxy.[[Construct]]
bool
ScriptedDirectProxyHandler::construct(JSContext *cx, HandleObject proxy, const CallArgs &args) const
{
    // step 1
    RootedObject handler(cx, GetDirectProxyHandlerObject(proxy));

    // step 2
    if (!handler) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_PROXY_REVOKED);
        return false;
    }

    // step 3
    RootedObject target(cx, proxy->as<ProxyObject>().target());

    /*
     * NB: Remember to throw a TypeError here if we change NewProxyObject so that this trap can get
     * called for non-callable objects. FIXME: See bug 1041756
     */

    // step 7
    RootedObject argsArray(cx, NewDenseCopiedArray(cx, args.length(), args.array()));
    if (!argsArray)
        return false;

    // step 4-5
    RootedValue trap(cx);
    if (!JSObject::getProperty(cx, handler, handler, cx->names().construct, &trap))
        return false;

    // step 6
    if (trap.isUndefined())
        return DirectProxyHandler::construct(cx, proxy, args);

    // step 8-9
    Value constructArgv[] = {
        ObjectValue(*target),
        ObjectValue(*argsArray)
    };
    RootedValue thisValue(cx, ObjectValue(*handler));
    if (!Invoke(cx, thisValue, trap, ArrayLength(constructArgv), constructArgv, args.rval()))
        return false;

    // step 10
    if (!args.rval().isObject()) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_PROXY_CONSTRUCT_OBJECT);
        return false;
    }
    return true;
}

bool
ScriptedDirectProxyHandler::isCallable(JSObject *obj) const
{
    MOZ_ASSERT(obj->as<ProxyObject>().handler() == &ScriptedDirectProxyHandler::singleton);
    return obj->as<ProxyObject>().extra(IS_CALLABLE_EXTRA).toBoolean();
}

const char ScriptedDirectProxyHandler::family = 0;
const ScriptedDirectProxyHandler ScriptedDirectProxyHandler::singleton;

bool
js::proxy(JSContext *cx, unsigned argc, jsval *vp)
{
    CallArgs args = CallArgsFromVp(argc, vp);
    if (args.length() < 2) {
        JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_MORE_ARGS_NEEDED,
                             "Proxy", "1", "s");
        return false;
    }
    RootedObject target(cx, NonNullObject(cx, args[0]));
    if (!target)
        return false;
    RootedObject handler(cx, NonNullObject(cx, args[1]));
    if (!handler)
        return false;
    RootedValue priv(cx, ObjectValue(*target));
    JSObject *proxy_ =
        NewProxyObject(cx, &ScriptedDirectProxyHandler::singleton,
                       priv, TaggedProto::LazyProto, cx->global());
    if (!proxy_)
        return false;
    Rooted<ProxyObject*> proxy(cx, &proxy_->as<ProxyObject>());
    bool targetIsCallable = target->isCallable(); // Can GC - don't compute it inline.
    proxy->setExtra(ScriptedDirectProxyHandler::HANDLER_EXTRA, ObjectValue(*handler));
    proxy->setExtra(ScriptedDirectProxyHandler::IS_CALLABLE_EXTRA, BooleanValue(targetIsCallable));
    args.rval().setObject(*proxy);
    return true;
}

static bool
RevokeProxy(JSContext *cx, unsigned argc, Value *vp)
{
    CallReceiver rec = CallReceiverFromVp(vp);

    RootedFunction func(cx, &rec.callee().as<JSFunction>());
    RootedObject p(cx, func->getExtendedSlot(ScriptedDirectProxyHandler::REVOKE_SLOT).toObjectOrNull());

    if (p) {
        func->setExtendedSlot(ScriptedDirectProxyHandler::REVOKE_SLOT, NullValue());

        MOZ_ASSERT(p->is<ProxyObject>());

        p->as<ProxyObject>().setSameCompartmentPrivate(NullValue());
        p->as<ProxyObject>().setExtra(ScriptedDirectProxyHandler::HANDLER_EXTRA, NullValue());
    }

    rec.rval().setUndefined();
    return true;
}

bool
js::proxy_revocable(JSContext *cx, unsigned argc, Value *vp)
{
    CallReceiver args = CallReceiverFromVp(vp);

    if (!proxy(cx, argc, vp))
        return false;

    RootedValue proxyVal(cx, args.rval());
    MOZ_ASSERT(proxyVal.toObject().is<ProxyObject>());

    RootedObject revoker(cx, NewFunctionByIdWithReserved(cx, RevokeProxy, 0, 0, cx->global(),
                         AtomToId(cx->names().revoke)));
    if (!revoker)
        return false;

    revoker->as<JSFunction>().initExtendedSlot(ScriptedDirectProxyHandler::REVOKE_SLOT, proxyVal);

    RootedObject result(cx, NewBuiltinClassInstance(cx, &JSObject::class_));
    if (!result)
        return false;

    RootedValue revokeVal(cx, ObjectValue(*revoker));
    if (!JSObject::defineProperty(cx, result, cx->names().proxy, proxyVal) ||
        !JSObject::defineProperty(cx, result, cx->names().revoke, revokeVal))
    {
        return false;
    }

    args.rval().setObject(*result);
    return true;
}

/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 * vim: set ts=8 sts=4 et sw=4 tw=99:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef jswrapper_h
#define jswrapper_h

#include "mozilla/Attributes.h"

#include "jsproxy.h"

namespace js {

class DummyFrameGuard;

/*
 * Helper for Wrapper::New default options.
 *
 * Callers of Wrapper::New() who wish to specify a prototype for the created
 * Wrapper, *MUST* construct a WrapperOptions with a JSContext.
 */
class MOZ_STACK_CLASS WrapperOptions : public ProxyOptions {
  public:
    WrapperOptions() : ProxyOptions(false),
                       proto_()
    {}

    explicit WrapperOptions(JSContext *cx) : ProxyOptions(false),
                                             proto_()
    {
        proto_.emplace(cx);
    }

    inline JSObject *proto() const;
    WrapperOptions &setProto(JSObject *protoArg) {
        MOZ_ASSERT(proto_);
        *proto_ = protoArg;
        return *this;
    }

  private:
    mozilla::Maybe<JS::RootedObject> proto_;
};

/*
 * A wrapper is a proxy with a target object to which it generally forwards
 * operations, but may restrict access to certain operations or instrument the
 * methods in various ways. A wrapper is distinct from a Direct Proxy Handler
 * in the sense that it can be "unwrapped" in C++, exposing the underlying
 * object (Direct Proxy Handlers have an underlying target object, but don't
 * expect to expose this object via any kind of unwrapping operation). Callers
 * should be careful to avoid unwrapping security wrappers in the wrong
 * context.
 */
class JS_FRIEND_API(Wrapper) : public DirectProxyHandler
{
    unsigned mFlags;

  public:
    using BaseProxyHandler::Action;

    enum Flags {
        CROSS_COMPARTMENT = 1 << 0,
        LAST_USED_FLAG = CROSS_COMPARTMENT
    };

    virtual bool defaultValue(JSContext *cx, HandleObject obj, JSType hint,
                              MutableHandleValue vp) const MOZ_OVERRIDE;

    static JSObject *New(JSContext *cx, JSObject *obj, JSObject *parent, const Wrapper *handler,
                         const WrapperOptions &options = WrapperOptions());

    static JSObject *Renew(JSContext *cx, JSObject *existing, JSObject *obj, const Wrapper *handler);

    static const Wrapper *wrapperHandler(JSObject *wrapper);

    static JSObject *wrappedObject(JSObject *wrapper);

    unsigned flags() const {
        return mFlags;
    }

    explicit MOZ_CONSTEXPR Wrapper(unsigned aFlags, bool aHasPrototype = false,
                                   bool aHasSecurityPolicy = false)
      : DirectProxyHandler(&family, aHasPrototype, aHasSecurityPolicy),
        mFlags(aFlags)
    { }

    virtual bool finalizeInBackground(Value priv) const MOZ_OVERRIDE;
    virtual bool isConstructor(JSObject *obj) const MOZ_OVERRIDE;

    static const char family;
    static const Wrapper singleton;
    static const Wrapper singletonWithPrototype;

    static JSObject *defaultProto;
};

inline JSObject *
WrapperOptions::proto() const
{
    return proto_ ? *proto_ : Wrapper::defaultProto;
}

/* Base class for all cross compartment wrapper handlers. */
class JS_FRIEND_API(CrossCompartmentWrapper) : public Wrapper
{
  public:
    explicit MOZ_CONSTEXPR CrossCompartmentWrapper(unsigned aFlags, bool aHasPrototype = false,
                                                   bool aHasSecurityPolicy = false)
      : Wrapper(CROSS_COMPARTMENT | aFlags, aHasPrototype, aHasSecurityPolicy)
    { }

    /* Standard internal methods. */
    virtual bool getOwnPropertyDescriptor(JSContext *cx, HandleObject wrapper, HandleId id,
                                          MutableHandle<JSPropertyDescriptor> desc) const MOZ_OVERRIDE;
    virtual bool defineProperty(JSContext *cx, HandleObject wrapper, HandleId id,
                                MutableHandle<JSPropertyDescriptor> desc) const MOZ_OVERRIDE;
    virtual bool ownPropertyKeys(JSContext *cx, HandleObject wrapper,
                                 AutoIdVector &props) const MOZ_OVERRIDE;
    virtual bool delete_(JSContext *cx, HandleObject wrapper, HandleId id, bool *bp) const MOZ_OVERRIDE;
    virtual bool enumerate(JSContext *cx, HandleObject wrapper, AutoIdVector &props) const MOZ_OVERRIDE;
    virtual bool isExtensible(JSContext *cx, HandleObject wrapper, bool *extensible) const MOZ_OVERRIDE;
    virtual bool preventExtensions(JSContext *cx, HandleObject wrapper) const MOZ_OVERRIDE;
    virtual bool getPrototypeOf(JSContext *cx, HandleObject proxy,
                                MutableHandleObject protop) const MOZ_OVERRIDE;
    virtual bool setPrototypeOf(JSContext *cx, HandleObject proxy, HandleObject proto,
                                bool *bp) const MOZ_OVERRIDE;
    virtual bool has(JSContext *cx, HandleObject wrapper, HandleId id, bool *bp) const MOZ_OVERRIDE;
    virtual bool get(JSContext *cx, HandleObject wrapper, HandleObject receiver,
                     HandleId id, MutableHandleValue vp) const MOZ_OVERRIDE;
    virtual bool set(JSContext *cx, HandleObject wrapper, HandleObject receiver,
                     HandleId id, bool strict, MutableHandleValue vp) const MOZ_OVERRIDE;
    virtual bool call(JSContext *cx, HandleObject wrapper, const CallArgs &args) const MOZ_OVERRIDE;
    virtual bool construct(JSContext *cx, HandleObject wrapper, const CallArgs &args) const MOZ_OVERRIDE;

    /* SpiderMonkey extensions. */
    virtual bool getPropertyDescriptor(JSContext *cx, HandleObject wrapper, HandleId id,
                                       MutableHandle<JSPropertyDescriptor> desc) const MOZ_OVERRIDE;
    virtual bool hasOwn(JSContext *cx, HandleObject wrapper, HandleId id, bool *bp) const MOZ_OVERRIDE;
    virtual bool getOwnEnumerablePropertyKeys(JSContext *cx, HandleObject wrapper,
                                              AutoIdVector &props) const MOZ_OVERRIDE;
    virtual bool iterate(JSContext *cx, HandleObject wrapper, unsigned flags,
                         MutableHandleValue vp) const MOZ_OVERRIDE;
    virtual bool nativeCall(JSContext *cx, IsAcceptableThis test, NativeImpl impl,
                            CallArgs args) const MOZ_OVERRIDE;
    virtual bool hasInstance(JSContext *cx, HandleObject wrapper, MutableHandleValue v,
                             bool *bp) const MOZ_OVERRIDE;
    virtual const char *className(JSContext *cx, HandleObject proxy) const MOZ_OVERRIDE;
    virtual JSString *fun_toString(JSContext *cx, HandleObject wrapper,
                                   unsigned indent) const MOZ_OVERRIDE;
    virtual bool regexp_toShared(JSContext *cx, HandleObject proxy, RegExpGuard *g) const MOZ_OVERRIDE;
    virtual bool boxedValue_unbox(JSContext *cx, HandleObject proxy, MutableHandleValue vp) const MOZ_OVERRIDE;
    virtual bool defaultValue(JSContext *cx, HandleObject wrapper, JSType hint,
                              MutableHandleValue vp) const MOZ_OVERRIDE;

    static const CrossCompartmentWrapper singleton;
    static const CrossCompartmentWrapper singletonWithPrototype;
};

/*
 * Base class for security wrappers. A security wrapper is potentially hiding
 * all or part of some wrapped object thus SecurityWrapper defaults to denying
 * access to the wrappee. This is the opposite of Wrapper which tries to be
 * completely transparent.
 *
 * NB: Currently, only a few ProxyHandler operations are overridden to deny
 * access, relying on derived SecurityWrapper to block access when necessary.
 */
template <class Base>
class JS_FRIEND_API(SecurityWrapper) : public Base
{
  public:
    explicit MOZ_CONSTEXPR SecurityWrapper(unsigned flags, bool hasPrototype = false)
      : Base(flags, hasPrototype, /* hasSecurityPolicy = */ true)
    { }

    virtual bool enter(JSContext *cx, HandleObject wrapper, HandleId id, Wrapper::Action act,
                       bool *bp) const MOZ_OVERRIDE;

    virtual bool defineProperty(JSContext *cx, HandleObject wrapper, HandleId id,
                                MutableHandle<JSPropertyDescriptor> desc) const MOZ_OVERRIDE;
    virtual bool isExtensible(JSContext *cx, HandleObject wrapper, bool *extensible) const MOZ_OVERRIDE;
    virtual bool preventExtensions(JSContext *cx, HandleObject wrapper) const MOZ_OVERRIDE;
    virtual bool setPrototypeOf(JSContext *cx, HandleObject proxy, HandleObject proto,
                                bool *bp) const MOZ_OVERRIDE;

    virtual bool nativeCall(JSContext *cx, IsAcceptableThis test, NativeImpl impl,
                            CallArgs args) const MOZ_OVERRIDE;
    virtual bool objectClassIs(HandleObject obj, ESClassValue classValue,
                               JSContext *cx) const MOZ_OVERRIDE;
    virtual bool regexp_toShared(JSContext *cx, HandleObject proxy, RegExpGuard *g) const MOZ_OVERRIDE;
    virtual bool boxedValue_unbox(JSContext *cx, HandleObject proxy, MutableHandleValue vp) const MOZ_OVERRIDE;
    virtual bool defaultValue(JSContext *cx, HandleObject wrapper, JSType hint,
                              MutableHandleValue vp) const MOZ_OVERRIDE;

    // Allow isCallable and isConstructor. They used to be class-level, and so could not be guarded
    // against.

    virtual bool watch(JSContext *cx, JS::HandleObject proxy, JS::HandleId id,
                       JS::HandleObject callable) const MOZ_OVERRIDE;
    virtual bool unwatch(JSContext *cx, JS::HandleObject proxy, JS::HandleId id) const MOZ_OVERRIDE;

    /*
     * Allow our subclasses to select the superclass behavior they want without
     * needing to specify an exact superclass.
     */
    typedef Base Permissive;
    typedef SecurityWrapper<Base> Restrictive;
};

typedef SecurityWrapper<Wrapper> SameCompartmentSecurityWrapper;
typedef SecurityWrapper<CrossCompartmentWrapper> CrossCompartmentSecurityWrapper;

extern JSObject *
TransparentObjectWrapper(JSContext *cx, HandleObject existing, HandleObject obj,
                         HandleObject parent);

inline bool
IsWrapper(JSObject *obj)
{
    return IsProxy(obj) && GetProxyHandler(obj)->family() == &Wrapper::family;
}

// Given a JSObject, returns that object stripped of wrappers. If
// stopAtOuter is true, then this returns the outer window if it was
// previously wrapped. Otherwise, this returns the first object for
// which JSObject::isWrapper returns false.
JS_FRIEND_API(JSObject *)
UncheckedUnwrap(JSObject *obj, bool stopAtOuter = true, unsigned *flagsp = nullptr);

// Given a JSObject, returns that object stripped of wrappers. At each stage,
// the security wrapper has the opportunity to veto the unwrap. Since checked
// code should never be unwrapping outer window wrappers, we always stop at
// outer windows.
JS_FRIEND_API(JSObject *)
CheckedUnwrap(JSObject *obj, bool stopAtOuter = true);

// Unwrap only the outermost security wrapper, with the same semantics as
// above. This is the checked version of Wrapper::wrappedObject.
JS_FRIEND_API(JSObject *)
UnwrapOneChecked(JSObject *obj, bool stopAtOuter = true);

JS_FRIEND_API(bool)
IsCrossCompartmentWrapper(JSObject *obj);

void
NukeCrossCompartmentWrapper(JSContext *cx, JSObject *wrapper);

bool
RemapWrapper(JSContext *cx, JSObject *wobj, JSObject *newTarget);

JS_FRIEND_API(bool)
RemapAllWrappersForObject(JSContext *cx, JSObject *oldTarget,
                          JSObject *newTarget);

// API to recompute all cross-compartment wrappers whose source and target
// match the given filters.
JS_FRIEND_API(bool)
RecomputeWrappers(JSContext *cx, const CompartmentFilter &sourceFilter,
                  const CompartmentFilter &targetFilter);

} /* namespace js */

#endif /* jswrapper_h */

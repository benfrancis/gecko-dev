/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 * vim: set ts=8 sts=4 et sw=4 tw=99:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * JS execution context.
 */

#include "jscntxtinlines.h"

#include "mozilla/ArrayUtils.h"
#include "mozilla/DebugOnly.h"
#include "mozilla/MemoryReporting.h"

#include <ctype.h>
#include <stdarg.h>
#include <string.h>
#ifdef ANDROID
# include <android/log.h>
# include <fstream>
# include <string>
#endif  // ANDROID

#include "jsatom.h"
#include "jscompartment.h"
#include "jsexn.h"
#include "jsfun.h"
#include "jsgc.h"
#include "jsiter.h"
#include "jsobj.h"
#include "jsopcode.h"
#include "jsprf.h"
#include "jspubtd.h"
#include "jsscript.h"
#include "jsstr.h"
#include "jstypes.h"
#include "jswatchpoint.h"

#include "gc/Marking.h"
#include "jit/Ion.h"
#include "js/CharacterEncoding.h"
#include "vm/Debugger.h"
#include "vm/HelperThreads.h"
#include "vm/Shape.h"

#include "jsobjinlines.h"
#include "jsscriptinlines.h"

#include "vm/Stack-inl.h"

using namespace js;
using namespace js::gc;

using mozilla::DebugOnly;
using mozilla::PodArrayZero;
using mozilla::PodZero;
using mozilla::PointerRangeSize;

bool
js::AutoCycleDetector::init()
{
    ObjectSet &set = cx->cycleDetectorSet;
    hashsetAddPointer = set.lookupForAdd(obj);
    if (!hashsetAddPointer) {
        if (!set.add(hashsetAddPointer, obj))
            return false;
        cyclic = false;
        hashsetGenerationAtInit = set.generation();
    }
    return true;
}

js::AutoCycleDetector::~AutoCycleDetector()
{
    if (!cyclic) {
        if (hashsetGenerationAtInit == cx->cycleDetectorSet.generation())
            cx->cycleDetectorSet.remove(hashsetAddPointer);
        else
            cx->cycleDetectorSet.remove(obj);
    }
}

void
js::TraceCycleDetectionSet(JSTracer *trc, js::ObjectSet &set)
{
    for (js::ObjectSet::Enum e(set); !e.empty(); e.popFront()) {
        JSObject *key = e.front();
        trc->setTracingLocation((void *)&e.front());
        MarkObjectRoot(trc, &key, "cycle detector table entry");
        if (key != e.front())
            e.rekeyFront(key);
    }
}

void
JSCompartment::sweepCallsiteClones()
{
    if (callsiteClones.initialized()) {
        for (CallsiteCloneTable::Enum e(callsiteClones); !e.empty(); e.popFront()) {
            CallsiteCloneKey key = e.front().key();
            if (IsObjectAboutToBeFinalizedFromAnyThread(&key.original) ||
                IsScriptAboutToBeFinalizedFromAnyThread(&key.script) ||
                IsObjectAboutToBeFinalizedFromAnyThread(e.front().value().unsafeGet()))
            {
                e.removeFront();
            } else if (key != e.front().key()) {
                e.rekeyFront(key);
            }
        }
    }
}

JSFunction *
js::ExistingCloneFunctionAtCallsite(const CallsiteCloneTable &table, JSFunction *fun,
                                    JSScript *script, jsbytecode *pc)
{
    MOZ_ASSERT(fun->nonLazyScript()->shouldCloneAtCallsite());
    MOZ_ASSERT(!fun->nonLazyScript()->enclosingStaticScope());
    MOZ_ASSERT(types::UseNewTypeForClone(fun));

    /*
     * If we start allocating function objects in the nursery, then the callsite
     * clone table will need a postbarrier.
     */
    MOZ_ASSERT(fun->isTenured());

    if (!table.initialized())
        return nullptr;

    CallsiteCloneTable::Ptr p = table.readonlyThreadsafeLookup(CallsiteCloneKey(fun, script, script->pcToOffset(pc)));
    if (p)
        return p->value();

    return nullptr;
}

JSFunction *
js::CloneFunctionAtCallsite(JSContext *cx, HandleFunction fun, HandleScript script, jsbytecode *pc)
{
    if (JSFunction *clone = ExistingCloneFunctionAtCallsite(cx->compartment()->callsiteClones, fun, script, pc))
        return clone;

    MOZ_ASSERT(fun->isSelfHostedBuiltin(),
               "only self-hosted builtin functions may be cloned at call sites, and "
               "Function.prototype.caller relies on this");

    RootedObject parent(cx, fun->environment());
    JSFunction *clone = CloneFunctionObject(cx, fun, parent);
    if (!clone)
        return nullptr;

    /*
     * Store a link back to the original for function.caller and avoid cloning
     * clones.
     */
    clone->nonLazyScript()->setIsCallsiteClone(fun);

    typedef CallsiteCloneKey Key;
    typedef CallsiteCloneTable Table;

    Table &table = cx->compartment()->callsiteClones;
    if (!table.initialized() && !table.init())
        return nullptr;

    if (!table.putNew(Key(fun, script, script->pcToOffset(pc)), clone))
        return nullptr;

    return clone;
}

JSContext *
js::NewContext(JSRuntime *rt, size_t stackChunkSize)
{
    JS_AbortIfWrongThread(rt);

    JSContext *cx = js_new<JSContext>(rt);
    if (!cx)
        return nullptr;

    if (!cx->cycleDetectorSet.init()) {
        js_delete(cx);
        return nullptr;
    }

    /*
     * Here the GC lock is still held after js_InitContextThreadAndLockGC took it and
     * the GC is not running on another thread.
     */
    rt->contextList.insertBack(cx);

    /*
     * If cx is the first context on this runtime, initialize well-known atoms,
     * keywords, numbers, strings and self-hosted scripts. If one of these
     * steps should fail, the runtime will be left in a partially initialized
     * state, with zeroes and nulls stored in the default-initialized remainder
     * of the struct.
     */
    if (!rt->haveCreatedContext) {
        JS_BeginRequest(cx);
        bool ok = rt->initializeAtoms(cx);
        if (ok)
            ok = rt->initSelfHosting(cx);

        if (ok && !rt->parentRuntime)
            ok = rt->transformToPermanentAtoms();

        JS_EndRequest(cx);

        if (!ok) {
            DestroyContext(cx, DCM_NEW_FAILED);
            return nullptr;
        }

        rt->haveCreatedContext = true;
    }

    JSContextCallback cxCallback = rt->cxCallback;
    if (cxCallback && !cxCallback(cx, JSCONTEXT_NEW, rt->cxCallbackData)) {
        DestroyContext(cx, DCM_NEW_FAILED);
        return nullptr;
    }

    return cx;
}

void
js::DestroyContext(JSContext *cx, DestroyContextMode mode)
{
    JSRuntime *rt = cx->runtime();
    JS_AbortIfWrongThread(rt);

    if (cx->outstandingRequests != 0)
        MOZ_CRASH();

    cx->checkNoGCRooters();

    if (mode != DCM_NEW_FAILED) {
        if (JSContextCallback cxCallback = rt->cxCallback) {
            /*
             * JSCONTEXT_DESTROY callback is not allowed to fail and must
             * return true.
             */
            JS_ALWAYS_TRUE(cxCallback(cx, JSCONTEXT_DESTROY,
                                      rt->cxCallbackData));
        }
    }

    cx->remove();
    bool last = !rt->hasContexts();
    if (last) {
        /*
         * Dump remaining type inference results while we still have a context.
         * This printing depends on atoms still existing.
         */
        for (CompartmentsIter c(rt, SkipAtoms); !c.done(); c.next())
            c->types.print(cx, false);
    }
    if (mode == DCM_FORCE_GC) {
        MOZ_ASSERT(!rt->isHeapBusy());
        JS::PrepareForFullGC(rt);
        rt->gc.gc(GC_NORMAL, JS::gcreason::DESTROY_CONTEXT);
    }
    js_delete_poison(cx);
}

void
ContextFriendFields::checkNoGCRooters() {
#ifdef DEBUG
    for (int i = 0; i < THING_ROOT_LIMIT; ++i)
        MOZ_ASSERT(thingGCRooters[i] == nullptr);
#endif
}

bool
AutoResolving::alreadyStartedSlow() const
{
    MOZ_ASSERT(link);
    AutoResolving *cursor = link;
    do {
        MOZ_ASSERT(this != cursor);
        if (object.get() == cursor->object && id.get() == cursor->id && kind == cursor->kind)
            return true;
    } while (!!(cursor = cursor->link));
    return false;
}

static void
ReportError(JSContext *cx, const char *message, JSErrorReport *reportp,
            JSErrorCallback callback, void *userRef)
{
    /*
     * Check the error report, and set a JavaScript-catchable exception
     * if the error is defined to have an associated exception.  If an
     * exception is thrown, then the JSREPORT_EXCEPTION flag will be set
     * on the error report, and exception-aware hosts should ignore it.
     */
    MOZ_ASSERT(reportp);
    if ((!callback || callback == js_GetErrorMessage) &&
        reportp->errorNumber == JSMSG_UNCAUGHT_EXCEPTION)
    {
        reportp->flags |= JSREPORT_EXCEPTION;
    }

    /*
     * Call the error reporter only if an exception wasn't raised.
     */
    if (!JS_IsRunning(cx) || !js_ErrorToException(cx, message, reportp, callback, userRef)) {
        if (message)
            CallErrorReporter(cx, message, reportp);
    }
}

/*
 * The given JSErrorReport object have been zeroed and must not outlive
 * cx->fp() (otherwise owned fields may become invalid).
 */
static void
PopulateReportBlame(JSContext *cx, JSErrorReport *report)
{
    /*
     * Walk stack until we find a frame that is associated with a non-builtin
     * rather than a builtin frame.
     */
    NonBuiltinFrameIter iter(cx);
    if (iter.done())
        return;

    report->filename = iter.scriptFilename();
    report->lineno = iter.computeLine(&report->column);
    report->isMuted = iter.mutedErrors();
}

/*
 * Since memory has been exhausted, avoid the normal error-handling path which
 * allocates an error object, report and callstack. If code is running, simply
 * throw the static atom "out of memory". If code is not running, call the
 * error reporter directly.
 *
 * Furthermore, callers of js_ReportOutOfMemory (viz., malloc) assume a GC does
 * not occur, so GC must be avoided or suppressed.
 */
void
js_ReportOutOfMemory(ThreadSafeContext *cxArg)
{
#ifdef JS_MORE_DETERMINISTIC
    /*
     * OOMs are non-deterministic, especially across different execution modes
     * (e.g. interpreter vs JIT). In more-deterministic builds, print to stderr
     * so that the fuzzers can detect this.
     */
    fprintf(stderr, "js_ReportOutOfMemory called\n");
#endif

    if (cxArg->isForkJoinContext()) {
        cxArg->asForkJoinContext()->setPendingAbortFatal(ParallelBailoutOutOfMemory);
        return;
    }

    if (!cxArg->isJSContext())
        return;

    JSContext *cx = cxArg->asJSContext();
    cx->runtime()->hadOutOfMemory = true;

    /* Report the oom. */
    if (JS::OutOfMemoryCallback oomCallback = cx->runtime()->oomCallback) {
        AutoSuppressGC suppressGC(cx);
        oomCallback(cx, cx->runtime()->oomCallbackData);
    }

    if (JS_IsRunning(cx)) {
        cx->setPendingException(StringValue(cx->names().outOfMemory));
        return;
    }

    /* Get the message for this error, but we don't expand any arguments. */
    const JSErrorFormatString *efs = js_GetErrorMessage(nullptr, JSMSG_OUT_OF_MEMORY);
    const char *msg = efs ? efs->format : "Out of memory";

    /* Fill out the report, but don't do anything that requires allocation. */
    JSErrorReport report;
    PodZero(&report);
    report.flags = JSREPORT_ERROR;
    report.errorNumber = JSMSG_OUT_OF_MEMORY;
    PopulateReportBlame(cx, &report);

    /* Report the error. */
    if (JSErrorReporter onError = cx->runtime()->errorReporter) {
        AutoSuppressGC suppressGC(cx);
        onError(cx, msg, &report);
    }

    /*
     * We would like to enforce the invariant that any exception reported
     * during an OOM situation does not require wrapping. Besides avoiding
     * allocation when memory is low, this reduces the number of places where
     * we might need to GC.
     *
     * When JS code is running, we set the pending exception to an atom, which
     * does not need wrapping. If no JS code is running, no exception should be
     * set at all.
     */
    MOZ_ASSERT(!cx->isExceptionPending());
}

JS_FRIEND_API(void)
js_ReportOverRecursed(JSContext *maybecx)
{
#ifdef JS_MORE_DETERMINISTIC
    /*
     * We cannot make stack depth deterministic across different
     * implementations (e.g. JIT vs. interpreter will differ in
     * their maximum stack depth).
     * However, we can detect externally when we hit the maximum
     * stack depth which is useful for external testing programs
     * like fuzzers.
     */
    fprintf(stderr, "js_ReportOverRecursed called\n");
#endif
    if (maybecx)
        JS_ReportErrorNumber(maybecx, js_GetErrorMessage, nullptr, JSMSG_OVER_RECURSED);
}

void
js_ReportOverRecursed(ThreadSafeContext *cx)
{
    if (cx->isJSContext())
        js_ReportOverRecursed(cx->asJSContext());
    else if (cx->isExclusiveContext())
        cx->asExclusiveContext()->addPendingOverRecursed();
}

void
js_ReportAllocationOverflow(ThreadSafeContext *cxArg)
{
    if (!cxArg)
        return;

    if (cxArg->isForkJoinContext()) {
        cxArg->asForkJoinContext()->setPendingAbortFatal(ParallelBailoutOutOfMemory);
        return;
    }

    if (!cxArg->isJSContext())
        return;
    JSContext *cx = cxArg->asJSContext();

    AutoSuppressGC suppressGC(cx);
    JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_ALLOC_OVERFLOW);
}

/*
 * Given flags and the state of cx, decide whether we should report an
 * error, a warning, or just continue execution normally.  Return
 * true if we should continue normally, without reporting anything;
 * otherwise, adjust *flags as appropriate and return false.
 */
static bool
checkReportFlags(JSContext *cx, unsigned *flags)
{
    if (JSREPORT_IS_STRICT_MODE_ERROR(*flags)) {
        /*
         * Error in strict code; warning with extra warnings option; okay
         * otherwise.  We assume that if the top frame is a native, then it is
         * strict if the nearest scripted frame is strict, see bug 536306.
         */
        JSScript *script = cx->currentScript();
        if (script && script->strict())
            *flags &= ~JSREPORT_WARNING;
        else if (cx->compartment()->options().extraWarnings(cx))
            *flags |= JSREPORT_WARNING;
        else
            return true;
    } else if (JSREPORT_IS_STRICT(*flags)) {
        /* Warning/error only when JSOPTION_STRICT is set. */
        if (!cx->compartment()->options().extraWarnings(cx))
            return true;
    }

    /* Warnings become errors when JSOPTION_WERROR is set. */
    if (JSREPORT_IS_WARNING(*flags) && cx->runtime()->options().werror())
        *flags &= ~JSREPORT_WARNING;

    return false;
}

bool
js_ReportErrorVA(JSContext *cx, unsigned flags, const char *format, va_list ap)
{
    char *message;
    char16_t *ucmessage;
    size_t messagelen;
    JSErrorReport report;
    bool warning;

    if (checkReportFlags(cx, &flags))
        return true;

    message = JS_vsmprintf(format, ap);
    if (!message)
        return false;
    messagelen = strlen(message);

    PodZero(&report);
    report.flags = flags;
    report.errorNumber = JSMSG_USER_DEFINED_ERROR;
    report.ucmessage = ucmessage = InflateString(cx, message, &messagelen);
    PopulateReportBlame(cx, &report);

    warning = JSREPORT_IS_WARNING(report.flags);

    ReportError(cx, message, &report, nullptr, nullptr);
    js_free(message);
    js_free(ucmessage);
    return warning;
}

/* |callee| requires a usage string provided by JS_DefineFunctionsWithHelp. */
void
js::ReportUsageError(JSContext *cx, HandleObject callee, const char *msg)
{
    const char *usageStr = "usage";
    PropertyName *usageAtom = Atomize(cx, usageStr, strlen(usageStr))->asPropertyName();
    RootedId id(cx, NameToId(usageAtom));
    DebugOnly<Shape *> shape = static_cast<Shape *>(callee->as<NativeObject>().lookup(cx, id));
    MOZ_ASSERT(!shape->configurable());
    MOZ_ASSERT(!shape->writable());
    MOZ_ASSERT(shape->hasDefaultGetter());

    RootedValue usage(cx);
    if (!JS_LookupProperty(cx, callee, "usage", &usage))
        return;

    if (usage.isUndefined()) {
        JS_ReportError(cx, "%s", msg);
    } else {
        JSString *str = usage.toString();
        if (!str->ensureFlat(cx))
            return;
        AutoStableStringChars chars(cx);
        if (!chars.initTwoByte(cx, str))
            return;

        JS_ReportError(cx, "%s. Usage: %hs", msg, chars.twoByteRange().start().get());
    }
}

bool
js::PrintError(JSContext *cx, FILE *file, const char *message, JSErrorReport *report,
               bool reportWarnings)
{
    if (!report) {
        fprintf(file, "%s\n", message);
        fflush(file);
        return false;
    }

    /* Conditionally ignore reported warnings. */
    if (JSREPORT_IS_WARNING(report->flags) && !reportWarnings)
        return false;

    char *prefix = nullptr;
    if (report->filename)
        prefix = JS_smprintf("%s:", report->filename);
    if (report->lineno) {
        char *tmp = prefix;
        prefix = JS_smprintf("%s%u:%u ", tmp ? tmp : "", report->lineno, report->column);
        JS_free(cx, tmp);
    }
    if (JSREPORT_IS_WARNING(report->flags)) {
        char *tmp = prefix;
        prefix = JS_smprintf("%s%swarning: ",
                             tmp ? tmp : "",
                             JSREPORT_IS_STRICT(report->flags) ? "strict " : "");
        JS_free(cx, tmp);
    }

    /* embedded newlines -- argh! */
    const char *ctmp;
    while ((ctmp = strchr(message, '\n')) != 0) {
        ctmp++;
        if (prefix)
            fputs(prefix, file);
        fwrite(message, 1, ctmp - message, file);
        message = ctmp;
    }

    /* If there were no filename or lineno, the prefix might be empty */
    if (prefix)
        fputs(prefix, file);
    fputs(message, file);

    if (report->linebuf) {
        /* report->linebuf usually ends with a newline. */
        int n = strlen(report->linebuf);
        fprintf(file, ":\n%s%s%s%s",
                prefix,
                report->linebuf,
                (n > 0 && report->linebuf[n-1] == '\n') ? "" : "\n",
                prefix);
        n = report->tokenptr - report->linebuf;
        for (int i = 0, j = 0; i < n; i++) {
            if (report->linebuf[i] == '\t') {
                for (int k = (j + 8) & ~7; j < k; j++) {
                    fputc('.', file);
                }
                continue;
            }
            fputc('.', file);
            j++;
        }
        fputc('^', file);
    }
    fputc('\n', file);
    fflush(file);
    JS_free(cx, prefix);
    return true;
}

/*
 * The arguments from ap need to be packaged up into an array and stored
 * into the report struct.
 *
 * The format string addressed by the error number may contain operands
 * identified by the format {N}, where N is a decimal digit. Each of these
 * is to be replaced by the Nth argument from the va_list. The complete
 * message is placed into reportp->ucmessage converted to a JSString.
 *
 * Returns true if the expansion succeeds (can fail if out of memory).
 */
bool
js_ExpandErrorArguments(ExclusiveContext *cx, JSErrorCallback callback,
                        void *userRef, const unsigned errorNumber,
                        char **messagep, JSErrorReport *reportp,
                        ErrorArgumentsType argumentsType, va_list ap)
{
    const JSErrorFormatString *efs;
    int i;
    int argCount;
    bool messageArgsPassed = !!reportp->messageArgs;

    *messagep = nullptr;

    if (!callback)
        callback = js_GetErrorMessage;

    {
        AutoSuppressGC suppressGC(cx);
        efs = callback(userRef, errorNumber);
    }

    if (efs) {
        reportp->exnType = efs->exnType;

        size_t totalArgsLength = 0;
        size_t argLengths[10]; /* only {0} thru {9} supported */
        argCount = efs->argCount;
        MOZ_ASSERT(argCount <= 10);
        if (argCount > 0) {
            /*
             * Gather the arguments into an array, and accumulate
             * their sizes. We allocate 1 more than necessary and
             * null it out to act as the caboose when we free the
             * pointers later.
             */
            if (messageArgsPassed) {
                MOZ_ASSERT(!reportp->messageArgs[argCount]);
            } else {
                reportp->messageArgs = cx->pod_malloc<const char16_t*>(argCount + 1);
                if (!reportp->messageArgs)
                    return false;
                /* nullptr-terminate for easy copying. */
                reportp->messageArgs[argCount] = nullptr;
            }
            for (i = 0; i < argCount; i++) {
                if (messageArgsPassed) {
                    /* Do nothing. */
                } else if (argumentsType == ArgumentsAreASCII) {
                    char *charArg = va_arg(ap, char *);
                    size_t charArgLength = strlen(charArg);
                    reportp->messageArgs[i] = InflateString(cx, charArg, &charArgLength);
                    if (!reportp->messageArgs[i])
                        goto error;
                } else {
                    reportp->messageArgs[i] = va_arg(ap, char16_t *);
                }
                argLengths[i] = js_strlen(reportp->messageArgs[i]);
                totalArgsLength += argLengths[i];
            }
        }
        /*
         * Parse the error format, substituting the argument X
         * for {X} in the format.
         */
        if (argCount > 0) {
            if (efs->format) {
                char16_t *buffer, *fmt, *out;
                int expandedArgs = 0;
                size_t expandedLength;
                size_t len = strlen(efs->format);

                buffer = fmt = InflateString(cx, efs->format, &len);
                if (!buffer)
                    goto error;
                expandedLength = len
                                 - (3 * argCount)       /* exclude the {n} */
                                 + totalArgsLength;

                /*
                * Note - the above calculation assumes that each argument
                * is used once and only once in the expansion !!!
                */
                reportp->ucmessage = out = cx->pod_malloc<char16_t>(expandedLength + 1);
                if (!out) {
                    js_free(buffer);
                    goto error;
                }
                while (*fmt) {
                    if (*fmt == '{') {
                        if (isdigit(fmt[1])) {
                            int d = JS7_UNDEC(fmt[1]);
                            MOZ_ASSERT(d < argCount);
                            js_strncpy(out, reportp->messageArgs[d],
                                       argLengths[d]);
                            out += argLengths[d];
                            fmt += 3;
                            expandedArgs++;
                            continue;
                        }
                    }
                    *out++ = *fmt++;
                }
                MOZ_ASSERT(expandedArgs == argCount);
                *out = 0;
                js_free(buffer);
                size_t msgLen = PointerRangeSize(static_cast<const char16_t *>(reportp->ucmessage),
                                                 static_cast<const char16_t *>(out));
                mozilla::Range<const char16_t> ucmsg(reportp->ucmessage, msgLen);
                *messagep = JS::LossyTwoByteCharsToNewLatin1CharsZ(cx, ucmsg).c_str();
                if (!*messagep)
                    goto error;
            }
        } else {
            /* Non-null messageArgs should have at least one non-null arg. */
            MOZ_ASSERT(!reportp->messageArgs);
            /*
             * Zero arguments: the format string (if it exists) is the
             * entire message.
             */
            if (efs->format) {
                size_t len;
                *messagep = DuplicateString(cx, efs->format).release();
                if (!*messagep)
                    goto error;
                len = strlen(*messagep);
                reportp->ucmessage = InflateString(cx, *messagep, &len);
                if (!reportp->ucmessage)
                    goto error;
            }
        }
    }
    if (*messagep == nullptr) {
        /* where's the right place for this ??? */
        const char *defaultErrorMessage
            = "No error message available for error number %d";
        size_t nbytes = strlen(defaultErrorMessage) + 16;
        *messagep = cx->pod_malloc<char>(nbytes);
        if (!*messagep)
            goto error;
        JS_snprintf(*messagep, nbytes, defaultErrorMessage, errorNumber);
    }
    return true;

error:
    if (!messageArgsPassed && reportp->messageArgs) {
        /* free the arguments only if we allocated them */
        if (argumentsType == ArgumentsAreASCII) {
            i = 0;
            while (reportp->messageArgs[i])
                js_free((void *)reportp->messageArgs[i++]);
        }
        js_free((void *)reportp->messageArgs);
        reportp->messageArgs = nullptr;
    }
    if (reportp->ucmessage) {
        js_free((void *)reportp->ucmessage);
        reportp->ucmessage = nullptr;
    }
    if (*messagep) {
        js_free((void *)*messagep);
        *messagep = nullptr;
    }
    return false;
}

bool
js_ReportErrorNumberVA(JSContext *cx, unsigned flags, JSErrorCallback callback,
                       void *userRef, const unsigned errorNumber,
                       ErrorArgumentsType argumentsType, va_list ap)
{
    JSErrorReport report;
    char *message;
    bool warning;

    if (checkReportFlags(cx, &flags))
        return true;
    warning = JSREPORT_IS_WARNING(flags);

    PodZero(&report);
    report.flags = flags;
    report.errorNumber = errorNumber;
    PopulateReportBlame(cx, &report);

    if (!js_ExpandErrorArguments(cx, callback, userRef, errorNumber,
                                 &message, &report, argumentsType, ap)) {
        return false;
    }

    ReportError(cx, message, &report, callback, userRef);

    js_free(message);
    if (report.messageArgs) {
        /*
         * js_ExpandErrorArguments owns its messageArgs only if it had to
         * inflate the arguments (from regular |char *|s).
         */
        if (argumentsType == ArgumentsAreASCII) {
            int i = 0;
            while (report.messageArgs[i])
                js_free((void *)report.messageArgs[i++]);
        }
        js_free((void *)report.messageArgs);
    }
    js_free((void *)report.ucmessage);

    return warning;
}

bool
js_ReportErrorNumberUCArray(JSContext *cx, unsigned flags, JSErrorCallback callback,
                            void *userRef, const unsigned errorNumber,
                            const char16_t **args)
{
    if (checkReportFlags(cx, &flags))
        return true;
    bool warning = JSREPORT_IS_WARNING(flags);

    JSErrorReport report;
    PodZero(&report);
    report.flags = flags;
    report.errorNumber = errorNumber;
    PopulateReportBlame(cx, &report);
    report.messageArgs = args;

    char *message;
    va_list dummy;
    if (!js_ExpandErrorArguments(cx, callback, userRef, errorNumber,
                                 &message, &report, ArgumentsAreUnicode, dummy)) {
        return false;
    }

    ReportError(cx, message, &report, callback, userRef);

    js_free(message);
    js_free((void *)report.ucmessage);

    return warning;
}

void
js::CallErrorReporter(JSContext *cx, const char *message, JSErrorReport *reportp)
{
    MOZ_ASSERT(message);
    MOZ_ASSERT(reportp);

    if (JSErrorReporter onError = cx->runtime()->errorReporter)
        onError(cx, message, reportp);
}

void
js_ReportIsNotDefined(JSContext *cx, const char *name)
{
    JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr, JSMSG_NOT_DEFINED, name);
}

bool
js_ReportIsNullOrUndefined(JSContext *cx, int spindex, HandleValue v,
                           HandleString fallback)
{
    char *bytes;
    bool ok;

    bytes = DecompileValueGenerator(cx, spindex, v, fallback);
    if (!bytes)
        return false;

    if (strcmp(bytes, js_undefined_str) == 0 ||
        strcmp(bytes, js_null_str) == 0) {
        ok = JS_ReportErrorFlagsAndNumber(cx, JSREPORT_ERROR,
                                          js_GetErrorMessage, nullptr,
                                          JSMSG_NO_PROPERTIES, bytes,
                                          nullptr, nullptr);
    } else if (v.isUndefined()) {
        ok = JS_ReportErrorFlagsAndNumber(cx, JSREPORT_ERROR,
                                          js_GetErrorMessage, nullptr,
                                          JSMSG_UNEXPECTED_TYPE, bytes,
                                          js_undefined_str, nullptr);
    } else {
        MOZ_ASSERT(v.isNull());
        ok = JS_ReportErrorFlagsAndNumber(cx, JSREPORT_ERROR,
                                          js_GetErrorMessage, nullptr,
                                          JSMSG_UNEXPECTED_TYPE, bytes,
                                          js_null_str, nullptr);
    }

    js_free(bytes);
    return ok;
}

void
js_ReportMissingArg(JSContext *cx, HandleValue v, unsigned arg)
{
    char argbuf[11];
    char *bytes;
    RootedAtom atom(cx);

    JS_snprintf(argbuf, sizeof argbuf, "%u", arg);
    bytes = nullptr;
    if (IsFunctionObject(v)) {
        atom = v.toObject().as<JSFunction>().atom();
        bytes = DecompileValueGenerator(cx, JSDVG_SEARCH_STACK,
                                        v, atom);
        if (!bytes)
            return;
    }
    JS_ReportErrorNumber(cx, js_GetErrorMessage, nullptr,
                         JSMSG_MISSING_FUN_ARG, argbuf,
                         bytes ? bytes : "");
    js_free(bytes);
}

bool
js_ReportValueErrorFlags(JSContext *cx, unsigned flags, const unsigned errorNumber,
                         int spindex, HandleValue v, HandleString fallback,
                         const char *arg1, const char *arg2)
{
    char *bytes;
    bool ok;

    MOZ_ASSERT(js_ErrorFormatString[errorNumber].argCount >= 1);
    MOZ_ASSERT(js_ErrorFormatString[errorNumber].argCount <= 3);
    bytes = DecompileValueGenerator(cx, spindex, v, fallback);
    if (!bytes)
        return false;

    ok = JS_ReportErrorFlagsAndNumber(cx, flags, js_GetErrorMessage,
                                      nullptr, errorNumber, bytes, arg1, arg2);
    js_free(bytes);
    return ok;
}

const JSErrorFormatString js_ErrorFormatString[JSErr_Limit] = {
#define MSG_DEF(name, count, exception, format) \
    { format, count, exception } ,
#include "js.msg"
#undef MSG_DEF
};

JS_FRIEND_API(const JSErrorFormatString *)
js_GetErrorMessage(void *userRef, const unsigned errorNumber)
{
    if (errorNumber > 0 && errorNumber < JSErr_Limit)
        return &js_ErrorFormatString[errorNumber];
    return nullptr;
}

bool
js::InvokeInterruptCallback(JSContext *cx)
{
    MOZ_ASSERT(cx->runtime()->requestDepth >= 1);

    JSRuntime *rt = cx->runtime();
    MOZ_ASSERT(rt->interrupt);

    // Reset the callback counter first, then run GC and yield. If another
    // thread is racing us here we will accumulate another callback request
    // which will be serviced at the next opportunity.
    rt->interrupt = false;

    // IonMonkey sets its stack limit to UINTPTR_MAX to trigger interrupt
    // callbacks.
    rt->resetJitStackLimit();

    cx->gcIfNeeded();

    rt->interruptPar = false;

    // A worker thread may have requested an interrupt after finishing an Ion
    // compilation.
    jit::AttachFinishedCompilations(cx);

    // Important: Additional callbacks can occur inside the callback handler
    // if it re-enters the JS engine. The embedding must ensure that the
    // callback is disconnected before attempting such re-entry.
    JSInterruptCallback cb = cx->runtime()->interruptCallback;
    if (!cb)
        return true;

    if (cb(cx)) {
        // Debugger treats invoking the interrupt callback as a "step", so
        // invoke the onStep handler.
        if (cx->compartment()->debugMode()) {
            ScriptFrameIter iter(cx);
            if (iter.script()->stepModeEnabled()) {
                RootedValue rval(cx);
                switch (Debugger::onSingleStep(cx, &rval)) {
                  case JSTRAP_ERROR:
                    return false;
                  case JSTRAP_CONTINUE:
                    return true;
                  case JSTRAP_RETURN:
                    // See note in Debugger::propagateForcedReturn.
                    Debugger::propagateForcedReturn(cx, iter.abstractFramePtr(), rval);
                    return false;
                  case JSTRAP_THROW:
                    cx->setPendingException(rval);
                    return false;
                  default:;
                }
            }
        }

        return true;
    }

    // No need to set aside any pending exception here: ComputeStackString
    // already does that.
    JSString *stack = ComputeStackString(cx);
    JSFlatString *flat = stack ? stack->ensureFlat(cx) : nullptr;

    const char16_t *chars;
    AutoStableStringChars stableChars(cx);
    if (flat && stableChars.initTwoByte(cx, flat))
        chars = stableChars.twoByteRange().start().get();
    else
        chars = MOZ_UTF16("(stack not available)");
    JS_ReportErrorFlagsAndNumberUC(cx, JSREPORT_WARNING, js_GetErrorMessage, nullptr,
                                   JSMSG_TERMINATED, chars);

    return false;
}

bool
js::HandleExecutionInterrupt(JSContext *cx)
{
    if (cx->runtime()->interrupt)
        return InvokeInterruptCallback(cx);
    return true;
}

ThreadSafeContext::ThreadSafeContext(JSRuntime *rt, PerThreadData *pt, ContextKind kind)
  : ContextFriendFields(rt),
    contextKind_(kind),
    perThreadData(pt),
    allocator_(nullptr)
{
}

bool
ThreadSafeContext::isForkJoinContext() const
{
    return contextKind_ == Context_ForkJoin;
}

ForkJoinContext *
ThreadSafeContext::asForkJoinContext()
{
    MOZ_ASSERT(isForkJoinContext());
    return reinterpret_cast<ForkJoinContext *>(this);
}

void
ThreadSafeContext::recoverFromOutOfMemory()
{
    // If this is not a JSContext, there's nothing to do.
    if (JSContext *maybecx = maybeJSContext()) {
        if (maybecx->isExceptionPending()) {
            MOZ_ASSERT(maybecx->isThrowingOutOfMemory());
            maybecx->clearPendingException();
        } else {
            MOZ_ASSERT(maybecx->runtime()->hadOutOfMemory);
        }
    }
}

JSContext::JSContext(JSRuntime *rt)
  : ExclusiveContext(rt, &rt->mainThread, Context_JS),
    throwing(false),
    unwrappedException_(UndefinedValue()),
    options_(),
    propagatingForcedReturn_(false),
    reportGranularity(JS_DEFAULT_JITREPORT_GRANULARITY),
    resolvingList(nullptr),
    generatingError(false),
    savedFrameChains_(),
    cycleDetectorSet(MOZ_THIS_IN_INITIALIZER_LIST()),
    data(nullptr),
    data2(nullptr),
    outstandingRequests(0),
    jitIsBroken(false)
#ifdef MOZ_TRACE_JSCALLS
  , functionCallback(nullptr)
#endif
{
    MOZ_ASSERT(static_cast<ContextFriendFields*>(this) ==
               ContextFriendFields::get(this));
}

JSContext::~JSContext()
{
    /* Free the stuff hanging off of cx. */
    MOZ_ASSERT(!resolvingList);
}

bool
JSContext::getPendingException(MutableHandleValue rval)
{
    MOZ_ASSERT(throwing);
    rval.set(unwrappedException_);
    if (IsAtomsCompartment(compartment()))
        return true;
    clearPendingException();
    if (!compartment()->wrap(this, rval))
        return false;
    assertSameCompartment(this, rval);
    setPendingException(rval);
    return true;
}

bool
JSContext::isThrowingOutOfMemory()
{
    return throwing && unwrappedException_ == StringValue(names().outOfMemory);
}

bool
JSContext::saveFrameChain()
{
    if (!savedFrameChains_.append(SavedFrameChain(compartment(), enterCompartmentDepth_)))
        return false;

    if (Activation *act = mainThread().activation())
        act->saveFrameChain();

    setCompartment(nullptr);
    enterCompartmentDepth_ = 0;

    return true;
}

void
JSContext::restoreFrameChain()
{
    MOZ_ASSERT(enterCompartmentDepth_ == 0); // We're about to clobber it, and it
                                            // will be wrong forevermore.
    SavedFrameChain sfc = savedFrameChains_.popCopy();
    setCompartment(sfc.compartment);
    enterCompartmentDepth_ = sfc.enterCompartmentCount;

    if (Activation *act = mainThread().activation())
        act->restoreFrameChain();
}

bool
JSContext::currentlyRunning() const
{
    for (ActivationIterator iter(runtime()); !iter.done(); ++iter) {
        if (iter->cx() == this) {
            if (iter->hasSavedFrameChain())
                return false;
            return true;
        }
    }

    return false;
}

static bool
ComputeIsJITBroken()
{
#if !defined(ANDROID) || defined(GONK)
    return false;
#else  // ANDROID
    if (getenv("JS_IGNORE_JIT_BROKENNESS")) {
        return false;
    }

    std::string line;

    // Check for the known-bad kernel version (2.6.29).
    std::ifstream osrelease("/proc/sys/kernel/osrelease");
    std::getline(osrelease, line);
    __android_log_print(ANDROID_LOG_INFO, "Gecko", "Detected osrelease `%s'",
                        line.c_str());

    if (line.npos == line.find("2.6.29")) {
        // We're using something other than 2.6.29, so the JITs should work.
        __android_log_print(ANDROID_LOG_INFO, "Gecko", "JITs are not broken");
        return false;
    }

    // We're using 2.6.29, and this causes trouble with the JITs on i9000.
    line = "";
    bool broken = false;
    std::ifstream cpuinfo("/proc/cpuinfo");
    do {
        if (0 == line.find("Hardware")) {
            static const char* const blacklist[] = {
                "SCH-I400",     // Samsung Continuum
                "SGH-T959",     // Samsung i9000, Vibrant device
                "SGH-I897",     // Samsung i9000, Captivate device
                "SCH-I500",     // Samsung i9000, Fascinate device
                "SPH-D700",     // Samsung i9000, Epic device
                "GT-I9000",     // Samsung i9000, UK/Europe device
                nullptr
            };
            for (const char* const* hw = &blacklist[0]; *hw; ++hw) {
                if (line.npos != line.find(*hw)) {
                    __android_log_print(ANDROID_LOG_INFO, "Gecko",
                                        "Blacklisted device `%s'", *hw);
                    broken = true;
                    break;
                }
            }
            break;
        }
        std::getline(cpuinfo, line);
    } while(!cpuinfo.fail() && !cpuinfo.eof());

    __android_log_print(ANDROID_LOG_INFO, "Gecko", "JITs are %sbroken",
                        broken ? "" : "not ");

    return broken;
#endif  // ifndef ANDROID
}

static bool
IsJITBrokenHere()
{
    static bool computedIsBroken = false;
    static bool isBroken = false;
    if (!computedIsBroken) {
        isBroken = ComputeIsJITBroken();
        computedIsBroken = true;
    }
    return isBroken;
}

void
JSContext::updateJITEnabled()
{
    jitIsBroken = IsJITBrokenHere();
}

size_t
JSContext::sizeOfIncludingThis(mozilla::MallocSizeOf mallocSizeOf) const
{
    /*
     * There are other JSContext members that could be measured; the following
     * ones have been found by DMD to be worth measuring.  More stuff may be
     * added later.
     */
    return mallocSizeOf(this) + cycleDetectorSet.sizeOfExcludingThis(mallocSizeOf);
}

void
JSContext::mark(JSTracer *trc)
{
    /* Stack frames and slots are traced by StackSpace::mark. */

    /* Mark other roots-by-definition in the JSContext. */
    if (isExceptionPending())
        MarkValueRoot(trc, &unwrappedException_, "unwrapped exception");

    TraceCycleDetectionSet(trc, cycleDetectorSet);
}

void *
ThreadSafeContext::stackLimitAddressForJitCode(StackKind kind)
{
#if defined(JS_ARM_SIMULATOR) || defined(JS_MIPS_SIMULATOR)
    return runtime_->mainThread.addressOfSimulatorStackLimit();
#endif
    return stackLimitAddress(kind);
}

JSVersion
JSContext::findVersion() const
{
    if (JSScript *script = currentScript(nullptr, ALLOW_CROSS_COMPARTMENT))
        return script->getVersion();

    if (compartment() && compartment()->options().version() != JSVERSION_UNKNOWN)
        return compartment()->options().version();

    return runtime()->defaultVersion();
}

#ifdef DEBUG

JS::AutoCheckRequestDepth::AutoCheckRequestDepth(JSContext *cx)
    : cx(cx)
{
    MOZ_ASSERT(cx->runtime()->requestDepth || cx->runtime()->isHeapBusy());
    MOZ_ASSERT(CurrentThreadCanAccessRuntime(cx->runtime()));
    cx->runtime()->checkRequestDepth++;
}

JS::AutoCheckRequestDepth::AutoCheckRequestDepth(ContextFriendFields *cxArg)
    : cx(static_cast<ThreadSafeContext *>(cxArg)->maybeJSContext())
{
    if (cx) {
        MOZ_ASSERT(cx->runtime()->requestDepth || cx->runtime()->isHeapBusy());
        MOZ_ASSERT(CurrentThreadCanAccessRuntime(cx->runtime()));
        cx->runtime()->checkRequestDepth++;
    }
}

JS::AutoCheckRequestDepth::~AutoCheckRequestDepth()
{
    if (cx) {
        MOZ_ASSERT(cx->runtime()->checkRequestDepth != 0);
        cx->runtime()->checkRequestDepth--;
    }
}

#endif

#ifdef JS_CRASH_DIAGNOSTICS
void CompartmentChecker::check(InterpreterFrame *fp)
{
    if (fp)
        check(fp->scopeChain());
}

void CompartmentChecker::check(AbstractFramePtr frame)
{
    if (frame)
        check(frame.scopeChain());
}
#endif

void
js::CrashAtUnhandlableOOM(const char *reason)
{
    char msgbuf[1024];
    JS_snprintf(msgbuf, sizeof(msgbuf), "[unhandlable oom] %s", reason);
    MOZ_ReportAssertionFailure(msgbuf, __FILE__, __LINE__);
    MOZ_CRASH();
}

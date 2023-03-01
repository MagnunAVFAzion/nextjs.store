export * from '@envelop/types';
import { isIntrospectionType, isObjectType, defaultFieldResolver, Kind, visit, BREAK, parse, specifiedRules, validate, execute, subscribe, GraphQLSchema, getOperationAST, GraphQLError } from 'graphql';

/**
 * This enum is used only internally in order to create nominal type for the disabled plugin
 */
var EnableIfBranded;
(function (EnableIfBranded) {
    EnableIfBranded[EnableIfBranded["DisabledPlugin"] = 0] = "DisabledPlugin";
})(EnableIfBranded || (EnableIfBranded = {}));
function isPluginEnabled(t) {
    return t !== EnableIfBranded.DisabledPlugin && t !== null;
}
/**
 * Utility function to enable a plugin.
 */
function enableIf(condition, plugin) {
    if (condition) {
        return typeof plugin === 'function' ? plugin() : plugin;
    }
    else {
        return EnableIfBranded.DisabledPlugin;
    }
}

const trackedSchemaSymbol = Symbol('TRACKED_SCHEMA');
const resolversHooksSymbol = Symbol('RESOLVERS_HOOKS');
function prepareTracedSchema(schema) {
    if (!schema || schema[trackedSchemaSymbol]) {
        return;
    }
    schema[trackedSchemaSymbol] = true;
    const entries = Object.values(schema.getTypeMap());
    for (const type of entries) {
        if (!isIntrospectionType(type) && isObjectType(type)) {
            const fields = Object.values(type.getFields());
            for (const field of fields) {
                let resolverFn = (field.resolve || defaultFieldResolver);
                field.resolve = async (root, args, context, info) => {
                    if (context && context[resolversHooksSymbol]) {
                        const hooks = context[resolversHooksSymbol];
                        const afterCalls = [];
                        for (const hook of hooks) {
                            const afterFn = await hook({
                                root,
                                args,
                                context,
                                info,
                                resolverFn,
                                replaceResolverFn: newFn => {
                                    resolverFn = newFn;
                                },
                            });
                            afterFn && afterCalls.push(afterFn);
                        }
                        try {
                            let result = await resolverFn(root, args, context, info);
                            for (const afterFn of afterCalls) {
                                afterFn({
                                    result,
                                    setResult: newResult => {
                                        result = newResult;
                                    },
                                });
                            }
                            return result;
                        }
                        catch (e) {
                            let resultErr = e;
                            for (const afterFn of afterCalls) {
                                afterFn({
                                    result: resultErr,
                                    setResult: newResult => {
                                        resultErr = newResult;
                                    },
                                });
                            }
                            throw resultErr;
                        }
                    }
                    else {
                        return resolverFn(root, args, context, info);
                    }
                };
            }
        }
    }
}

const envelopIsIntrospectionSymbol = Symbol('ENVELOP_IS_INTROSPECTION');
function isOperationDefinition(def) {
    return def.kind === Kind.OPERATION_DEFINITION;
}
function isIntrospectionOperation(operation) {
    if (operation.kind === 'OperationDefinition') {
        let hasIntrospectionField = false;
        visit(operation, {
            Field: node => {
                if (node.name.value === '__schema') {
                    hasIntrospectionField = true;
                    return BREAK;
                }
            },
        });
        return hasIntrospectionField;
    }
    return false;
}
function isIntrospectionDocument(document) {
    const operations = document.definitions.filter(isOperationDefinition);
    return operations.some(op => isIntrospectionOperation(op));
}
function isIntrospectionOperationString(operation) {
    return (typeof operation === 'string' ? operation : operation.body).indexOf('__schema') !== -1;
}
function getSubscribeArgs(args) {
    return args.length === 1
        ? args[0]
        : {
            schema: args[0],
            document: args[1],
            rootValue: args[2],
            contextValue: args[3],
            variableValues: args[4],
            operationName: args[5],
            fieldResolver: args[6],
            subscribeFieldResolver: args[7],
        };
}
/**
 * Utility function for making a subscribe function that handles polymorphic arguments.
 */
const makeSubscribe = (subscribeFn) => ((...polyArgs) => subscribeFn(getSubscribeArgs(polyArgs)));
function mapAsyncIterator(source, mapper) {
    const iterator = source[Symbol.asyncIterator]();
    async function mapResult(result) {
        var _a;
        if (result.done) {
            return result;
        }
        try {
            return { value: await mapper(result.value), done: false };
        }
        catch (error) {
            try {
                await ((_a = iterator.return) === null || _a === void 0 ? void 0 : _a.call(iterator));
            }
            catch (_error) {
                /* ignore error */
            }
            throw error;
        }
    }
    const stream = {
        [Symbol.asyncIterator]() {
            return stream;
        },
        async next() {
            return await mapResult(await iterator.next());
        },
        async return() {
            var _a;
            const promise = (_a = iterator.return) === null || _a === void 0 ? void 0 : _a.call(iterator);
            return promise ? await mapResult(await promise) : { value: undefined, done: true };
        },
        async throw(error) {
            var _a;
            const promise = (_a = iterator.throw) === null || _a === void 0 ? void 0 : _a.call(iterator);
            if (promise) {
                return await mapResult(await promise);
            }
            // if the source has no throw method we just re-throw error
            // usually throw is not called anyways
            throw error;
        },
    };
    return stream;
}
function getExecuteArgs(args) {
    return args.length === 1
        ? args[0]
        : {
            schema: args[0],
            document: args[1],
            rootValue: args[2],
            contextValue: args[3],
            variableValues: args[4],
            operationName: args[5],
            fieldResolver: args[6],
            typeResolver: args[7],
        };
}
/**
 * Utility function for making a execute function that handles polymorphic arguments.
 */
const makeExecute = (executeFn) => ((...polyArgs) => executeFn(getExecuteArgs(polyArgs)));
/**
 * Returns true if the provided object implements the AsyncIterator protocol via
 * implementing a `Symbol.asyncIterator` method.
 *
 * Source: https://github.com/graphql/graphql-js/blob/main/src/jsutils/isAsyncIterable.ts
 */
function isAsyncIterable(maybeAsyncIterable) {
    return (typeof maybeAsyncIterable === 'object' &&
        maybeAsyncIterable != null &&
        typeof maybeAsyncIterable[Symbol.asyncIterator] === 'function');
}
/**
 * A utility function for handling `onExecuteDone` hook result, for simplifying the handling of AsyncIterable returned from `execute`.
 *
 * @param payload The payload send to `onExecuteDone` hook function
 * @param fn The handler to be executed on each result
 * @returns a subscription for streamed results, or undefined in case of an non-async
 */
function handleStreamOrSingleExecutionResult(payload, fn) {
    if (isAsyncIterable(payload.result)) {
        return { onNext: fn };
    }
    else {
        fn({
            args: payload.args,
            result: payload.result,
            setResult: payload.setResult,
        });
        return undefined;
    }
}
function finalAsyncIterator(source, onFinal) {
    const iterator = source[Symbol.asyncIterator]();
    let isDone = false;
    const stream = {
        [Symbol.asyncIterator]() {
            return stream;
        },
        async next() {
            const result = await iterator.next();
            if (result.done && isDone === false) {
                isDone = true;
                onFinal();
            }
            return result;
        },
        async return() {
            var _a;
            const promise = (_a = iterator.return) === null || _a === void 0 ? void 0 : _a.call(iterator);
            if (isDone === false) {
                isDone = true;
                onFinal();
            }
            return promise ? await promise : { done: true, value: undefined };
        },
        async throw(error) {
            var _a;
            const promise = (_a = iterator.throw) === null || _a === void 0 ? void 0 : _a.call(iterator);
            if (promise) {
                return await promise;
            }
            // if the source has no throw method we just re-throw error
            // usually throw is not called anyways
            throw error;
        },
    };
    return stream;
}
function errorAsyncIterator(source, onError) {
    const iterator = source[Symbol.asyncIterator]();
    const stream = {
        [Symbol.asyncIterator]() {
            return stream;
        },
        async next() {
            try {
                return await iterator.next();
            }
            catch (error) {
                onError(error);
                return { done: true, value: undefined };
            }
        },
        async return() {
            var _a;
            const promise = (_a = iterator.return) === null || _a === void 0 ? void 0 : _a.call(iterator);
            return promise ? await promise : { done: true, value: undefined };
        },
        async throw(error) {
            var _a;
            const promise = (_a = iterator.throw) === null || _a === void 0 ? void 0 : _a.call(iterator);
            if (promise) {
                return await promise;
            }
            // if the source has no throw method we just re-throw error
            // usually throw is not called anyways
            throw error;
        },
    };
    return stream;
}

function createEnvelopOrchestrator(plugins) {
    let schema = null;
    let initDone = false;
    // Define the initial method for replacing the GraphQL schema, this is needed in order
    // to allow setting the schema from the onPluginInit callback. We also need to make sure
    // here not to call the same plugin that initiated the schema switch.
    const replaceSchema = (newSchema, ignorePluginIndex = -1) => {
        prepareTracedSchema(newSchema);
        schema = newSchema;
        if (initDone) {
            for (const [i, plugin] of plugins.entries()) {
                if (i !== ignorePluginIndex) {
                    plugin.onSchemaChange &&
                        plugin.onSchemaChange({
                            schema,
                            replaceSchema: schemaToSet => {
                                replaceSchema(schemaToSet, i);
                            },
                        });
                }
            }
        }
    };
    const contextErrorHandlers = [];
    // Iterate all plugins and trigger onPluginInit
    for (const [i, plugin] of plugins.entries()) {
        plugin.onPluginInit &&
            plugin.onPluginInit({
                plugins,
                addPlugin: newPlugin => {
                    plugins.push(newPlugin);
                },
                setSchema: modifiedSchema => replaceSchema(modifiedSchema, i),
                registerContextErrorHandler: handler => contextErrorHandlers.push(handler),
            });
    }
    // A set of before callbacks defined here in order to allow it to be used later
    const beforeCallbacks = {
        init: [],
        parse: [],
        validate: [],
        subscribe: [],
        execute: [],
        context: [],
    };
    for (const { onContextBuilding, onExecute, onParse, onSubscribe, onValidate, onEnveloped } of plugins) {
        onEnveloped && beforeCallbacks.init.push(onEnveloped);
        onContextBuilding && beforeCallbacks.context.push(onContextBuilding);
        onExecute && beforeCallbacks.execute.push(onExecute);
        onParse && beforeCallbacks.parse.push(onParse);
        onSubscribe && beforeCallbacks.subscribe.push(onSubscribe);
        onValidate && beforeCallbacks.validate.push(onValidate);
    }
    const init = initialContext => {
        for (const [i, onEnveloped] of beforeCallbacks.init.entries()) {
            onEnveloped({
                context: initialContext,
                extendContext: extension => {
                    if (!initialContext) {
                        return;
                    }
                    Object.assign(initialContext, extension);
                },
                setSchema: modifiedSchema => replaceSchema(modifiedSchema, i),
            });
        }
    };
    const customParse = beforeCallbacks.parse.length
        ? initialContext => (source, parseOptions) => {
            let result = null;
            let parseFn = parse;
            const context = initialContext;
            const afterCalls = [];
            for (const onParse of beforeCallbacks.parse) {
                const afterFn = onParse({
                    context,
                    extendContext: extension => {
                        Object.assign(context, extension);
                    },
                    params: { source, options: parseOptions },
                    parseFn,
                    setParseFn: newFn => {
                        parseFn = newFn;
                    },
                    setParsedDocument: newDoc => {
                        result = newDoc;
                    },
                });
                afterFn && afterCalls.push(afterFn);
            }
            if (result === null) {
                try {
                    result = parseFn(source, parseOptions);
                }
                catch (e) {
                    result = e;
                }
            }
            for (const afterCb of afterCalls) {
                afterCb({
                    context,
                    extendContext: extension => {
                        Object.assign(context, extension);
                    },
                    replaceParseResult: newResult => {
                        result = newResult;
                    },
                    result,
                });
            }
            if (result === null) {
                throw new Error(`Failed to parse document.`);
            }
            if (result instanceof Error) {
                throw result;
            }
            return result;
        }
        : () => parse;
    const customValidate = beforeCallbacks.validate.length
        ? initialContext => (schema, documentAST, rules, typeInfo, validationOptions) => {
            let actualRules = rules ? [...rules] : undefined;
            let validateFn = validate;
            let result = null;
            const context = initialContext;
            const afterCalls = [];
            for (const onValidate of beforeCallbacks.validate) {
                const afterFn = onValidate({
                    context,
                    extendContext: extension => {
                        Object.assign(context, extension);
                    },
                    params: {
                        schema,
                        documentAST,
                        rules: actualRules,
                        typeInfo,
                        options: validationOptions,
                    },
                    validateFn,
                    addValidationRule: rule => {
                        if (!actualRules) {
                            actualRules = [...specifiedRules];
                        }
                        actualRules.push(rule);
                    },
                    setValidationFn: newFn => {
                        validateFn = newFn;
                    },
                    setResult: newResults => {
                        result = newResults;
                    },
                });
                afterFn && afterCalls.push(afterFn);
            }
            if (!result) {
                result = validateFn(schema, documentAST, actualRules, typeInfo, validationOptions);
            }
            const valid = result.length === 0;
            for (const afterCb of afterCalls) {
                afterCb({
                    valid,
                    result,
                    context,
                    extendContext: extension => {
                        Object.assign(context, extension);
                    },
                });
            }
            return result;
        }
        : () => validate;
    const customContextFactory = beforeCallbacks.context.length
        ? initialContext => async (orchestratorCtx) => {
            const afterCalls = [];
            try {
                let context = orchestratorCtx ? { ...initialContext, ...orchestratorCtx } : initialContext;
                for (const onContext of beforeCallbacks.context) {
                    const afterHookResult = await onContext({
                        context,
                        extendContext: extension => {
                            context = { ...context, ...extension };
                        },
                    });
                    if (typeof afterHookResult === 'function') {
                        afterCalls.push(afterHookResult);
                    }
                }
                for (const afterCb of afterCalls) {
                    afterCb({
                        context,
                        extendContext: extension => {
                            context = { ...context, ...extension };
                        },
                    });
                }
                return context;
            }
            catch (err) {
                let error = err;
                for (const errorCb of contextErrorHandlers) {
                    errorCb({
                        error,
                        setError: err => {
                            error = err;
                        },
                    });
                }
                throw error;
            }
        }
        : initialContext => orchestratorCtx => orchestratorCtx ? { ...initialContext, ...orchestratorCtx } : initialContext;
    const customSubscribe = makeSubscribe(async (args) => {
        const onResolversHandlers = [];
        let subscribeFn = subscribe;
        const afterCalls = [];
        const subscribeErrorHandlers = [];
        let context = args.contextValue || {};
        for (const onSubscribe of beforeCallbacks.subscribe) {
            const after = await onSubscribe({
                subscribeFn,
                setSubscribeFn: newSubscribeFn => {
                    subscribeFn = newSubscribeFn;
                },
                extendContext: extension => {
                    context = { ...context, ...extension };
                },
                args: args,
            });
            if (after) {
                if (after.onSubscribeResult) {
                    afterCalls.push(after.onSubscribeResult);
                }
                if (after.onSubscribeError) {
                    subscribeErrorHandlers.push(after.onSubscribeError);
                }
                if (after.onResolverCalled) {
                    onResolversHandlers.push(after.onResolverCalled);
                }
            }
        }
        if (onResolversHandlers.length) {
            context[resolversHooksSymbol] = onResolversHandlers;
        }
        let result = await subscribeFn({
            ...args,
            contextValue: context,
            // Casted for GraphQL.js 15 compatibility
            // Can be removed once we drop support for GraphQL.js 15
        });
        const onNextHandler = [];
        const onEndHandler = [];
        for (const afterCb of afterCalls) {
            const hookResult = afterCb({
                args: args,
                result,
                setResult: newResult => {
                    result = newResult;
                },
            });
            if (hookResult) {
                if (hookResult.onNext) {
                    onNextHandler.push(hookResult.onNext);
                }
                if (hookResult.onEnd) {
                    onEndHandler.push(hookResult.onEnd);
                }
            }
        }
        if (onNextHandler.length && isAsyncIterable(result)) {
            result = mapAsyncIterator(result, async (result) => {
                for (const onNext of onNextHandler) {
                    await onNext({
                        args: args,
                        result,
                        setResult: newResult => (result = newResult),
                    });
                }
                return result;
            });
        }
        if (onEndHandler.length && isAsyncIterable(result)) {
            result = finalAsyncIterator(result, () => {
                for (const onEnd of onEndHandler) {
                    onEnd();
                }
            });
        }
        if (subscribeErrorHandlers.length && isAsyncIterable(result)) {
            result = errorAsyncIterator(result, err => {
                let error = err;
                for (const handler of subscribeErrorHandlers) {
                    handler({
                        error,
                        setError: err => {
                            error = err;
                        },
                    });
                }
                throw error;
            });
        }
        return result;
    });
    const customExecute = beforeCallbacks.execute.length
        ? makeExecute(async (args) => {
            const onResolversHandlers = [];
            let executeFn = execute;
            let result;
            const afterCalls = [];
            let context = args.contextValue || {};
            for (const onExecute of beforeCallbacks.execute) {
                let stopCalled = false;
                const after = await onExecute({
                    executeFn,
                    setExecuteFn: newExecuteFn => {
                        executeFn = newExecuteFn;
                    },
                    setResultAndStopExecution: stopResult => {
                        stopCalled = true;
                        result = stopResult;
                    },
                    extendContext: extension => {
                        if (typeof extension === 'object') {
                            context = {
                                ...(context || {}),
                                ...extension,
                            };
                        }
                        else {
                            throw new Error(`Invalid context extension provided! Expected "object", got: "${JSON.stringify(extension)}" (${typeof extension})`);
                        }
                    },
                    args: args,
                });
                if (stopCalled) {
                    return result;
                }
                if (after) {
                    if (after.onExecuteDone) {
                        afterCalls.push(after.onExecuteDone);
                    }
                    if (after.onResolverCalled) {
                        onResolversHandlers.push(after.onResolverCalled);
                    }
                }
            }
            if (onResolversHandlers.length) {
                context[resolversHooksSymbol] = onResolversHandlers;
            }
            result = (await executeFn({
                ...args,
                contextValue: context,
            }));
            const onNextHandler = [];
            const onEndHandler = [];
            for (const afterCb of afterCalls) {
                const hookResult = await afterCb({
                    args: args,
                    result,
                    setResult: newResult => {
                        result = newResult;
                    },
                });
                if (hookResult) {
                    if (hookResult.onNext) {
                        onNextHandler.push(hookResult.onNext);
                    }
                    if (hookResult.onEnd) {
                        onEndHandler.push(hookResult.onEnd);
                    }
                }
            }
            if (onNextHandler.length && isAsyncIterable(result)) {
                result = mapAsyncIterator(result, async (result) => {
                    for (const onNext of onNextHandler) {
                        await onNext({
                            args: args,
                            result,
                            setResult: newResult => {
                                result = newResult;
                            },
                        });
                    }
                    return result;
                });
            }
            if (onEndHandler.length && isAsyncIterable(result)) {
                result = finalAsyncIterator(result, () => {
                    for (const onEnd of onEndHandler) {
                        onEnd();
                    }
                });
            }
            return result;
        })
        : makeExecute(execute);
    initDone = true;
    // This is done in order to trigger the first schema available, to allow plugins that needs the schema
    // eagerly to have it.
    if (schema) {
        for (const [i, plugin] of plugins.entries()) {
            plugin.onSchemaChange &&
                plugin.onSchemaChange({
                    schema,
                    replaceSchema: modifiedSchema => replaceSchema(modifiedSchema, i),
                });
        }
    }
    return {
        getCurrentSchema() {
            return schema;
        },
        init,
        parse: customParse,
        validate: customValidate,
        execute: customExecute,
        subscribe: customSubscribe,
        contextFactory: customContextFactory,
    };
}

var _a;
const getTimestamp = typeof globalThis !== 'undefined' && ((_a = globalThis === null || globalThis === void 0 ? void 0 : globalThis.performance) === null || _a === void 0 ? void 0 : _a.now) ? () => performance.now() : () => Date.now();
const measure = () => {
    const start = getTimestamp();
    return () => {
        const end = getTimestamp();
        return end - start;
    };
};
const tracingSymbol = Symbol('envelopTracing');
function traceOrchestrator(orchestrator) {
    const createTracer = (name, ctx) => {
        const end = measure();
        return () => {
            ctx[tracingSymbol][name] = end();
        };
    };
    return {
        ...orchestrator,
        init: (ctx = {}) => {
            ctx[tracingSymbol] = ctx[tracingSymbol] || {};
            const done = createTracer('init', ctx || {});
            try {
                return orchestrator.init(ctx);
            }
            finally {
                done();
            }
        },
        parse: (ctx = {}) => {
            ctx[tracingSymbol] = ctx[tracingSymbol] || {};
            const actualFn = orchestrator.parse(ctx);
            return (...args) => {
                const done = createTracer('parse', ctx);
                try {
                    return actualFn(...args);
                }
                finally {
                    done();
                }
            };
        },
        validate: (ctx = {}) => {
            ctx[tracingSymbol] = ctx[tracingSymbol] || {};
            const actualFn = orchestrator.validate(ctx);
            return (...args) => {
                const done = createTracer('validate', ctx);
                try {
                    return actualFn(...args);
                }
                finally {
                    done();
                }
            };
        },
        execute: async (argsOrSchema, document, rootValue, contextValue, variableValues, operationName, fieldResolver, typeResolver) => {
            const args = argsOrSchema instanceof GraphQLSchema
                ? {
                    schema: argsOrSchema,
                    document: document,
                    rootValue,
                    contextValue,
                    variableValues,
                    operationName,
                    fieldResolver,
                    typeResolver,
                }
                : argsOrSchema;
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore GraphQL.js types contextValue as unknown
            const done = createTracer('execute', args.contextValue || {});
            try {
                const result = await orchestrator.execute(args);
                done();
                if (!isAsyncIterable(result)) {
                    result.extensions = result.extensions || {};
                    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                    // @ts-ignore GraphQL.js types contextValue as unknown
                    result.extensions.envelopTracing = args.contextValue[tracingSymbol];
                }
                else {
                    // eslint-disable-next-line no-console
                    console.warn(`"traceOrchestrator" encountered a AsyncIterator which is not supported yet, so tracing data is not available for the operation.`);
                }
                return result;
            }
            catch (e) {
                done();
                throw e;
            }
        },
        subscribe: async (argsOrSchema, document, rootValue, contextValue, variableValues, operationName, fieldResolver, subscribeFieldResolver) => {
            const args = argsOrSchema instanceof GraphQLSchema
                ? {
                    schema: argsOrSchema,
                    document: document,
                    rootValue,
                    contextValue,
                    variableValues,
                    operationName,
                    fieldResolver,
                    subscribeFieldResolver,
                }
                : argsOrSchema;
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore GraphQL.js types contextValue as unknown
            const done = createTracer('subscribe', args.contextValue || {});
            try {
                return await orchestrator.subscribe(args);
            }
            finally {
                done();
            }
        },
        contextFactory: (ctx = {}) => {
            const actualFn = orchestrator.contextFactory(ctx);
            return async (childCtx) => {
                const done = createTracer('contextFactory', ctx);
                try {
                    return await actualFn(childCtx);
                }
                finally {
                    done();
                }
            };
        },
    };
}

function envelop(options) {
    const plugins = options.plugins.filter(isPluginEnabled);
    let orchestrator = createEnvelopOrchestrator(plugins);
    if (options.enableInternalTracing) {
        orchestrator = traceOrchestrator(orchestrator);
    }
    const getEnveloped = (initialContext = {}) => {
        const typedOrchestrator = orchestrator;
        typedOrchestrator.init(initialContext);
        return {
            parse: typedOrchestrator.parse(initialContext),
            validate: typedOrchestrator.validate(initialContext),
            contextFactory: typedOrchestrator.contextFactory(initialContext),
            execute: typedOrchestrator.execute,
            subscribe: typedOrchestrator.subscribe,
            schema: typedOrchestrator.getCurrentSchema(),
        };
    };
    getEnveloped._plugins = plugins;
    return getEnveloped;
}

const useEnvelop = (envelop) => {
    return {
        onPluginInit({ addPlugin }) {
            for (const plugin of envelop._plugins) {
                addPlugin(plugin);
            }
        },
    };
};

const DEFAULT_OPTIONS = {
    logFn: console.log,
};
const useLogger = (rawOptions = DEFAULT_OPTIONS) => {
    const options = {
        DEFAULT_OPTIONS,
        ...rawOptions,
    };
    return {
        onParse({ extendContext, params }) {
            if (options.skipIntrospection && isIntrospectionOperationString(params.source)) {
                extendContext({
                    [envelopIsIntrospectionSymbol]: true,
                });
            }
        },
        onExecute({ args }) {
            if (args.contextValue[envelopIsIntrospectionSymbol]) {
                return;
            }
            options.logFn('execute-start', { args });
            return {
                onExecuteDone: ({ result }) => {
                    options.logFn('execute-end', { args, result });
                },
            };
        },
        onSubscribe({ args }) {
            if (args.contextValue[envelopIsIntrospectionSymbol]) {
                return;
            }
            options.logFn('subscribe-start', { args });
            return {
                onSubscribeResult: ({ result }) => {
                    options.logFn('subscribe-end', { args, result });
                },
            };
        },
    };
};

const HR_TO_NS = 1e9;
const NS_TO_MS = 1e6;
const DEFAULT_OPTIONS$1 = {
    onExecutionMeasurement: (args, timing) => console.log(`Operation execution "${args.operationName}" done in ${timing.ms}ms`),
    onSubscriptionMeasurement: (args, timing) => console.log(`Operation subscription "${args.operationName}" done in ${timing.ms}ms`),
    onParsingMeasurement: (source, timing) => console.log(`Parsing "${source}" done in ${timing.ms}ms`),
    onValidationMeasurement: (document, timing) => { var _a, _b; return console.log(`Validation "${((_b = (_a = getOperationAST(document)) === null || _a === void 0 ? void 0 : _a.name) === null || _b === void 0 ? void 0 : _b.value) || '-'}" done in ${timing.ms}ms`); },
    onResolverMeasurement: (info, timing) => console.log(`\tResolver of "${info.parentType.toString()}.${info.fieldName}" done in ${timing.ms}ms`),
    onContextBuildingMeasurement: (timing) => console.log(`Context building done in ${timing.ms}ms`),
};
const deltaFrom = (hrtime) => {
    // const delta = process.hrtime(hrtime);
    const delta = [0, 0];
    const ns = delta[0] * HR_TO_NS + delta[1];
    return {
        ns,
        get ms() {
            return ns / NS_TO_MS;
        },
    };
};
const useTiming = (rawOptions) => {
    const options = {
        ...DEFAULT_OPTIONS$1,
        ...(rawOptions || {}),
    };
    const result = {};
    if (options.onContextBuildingMeasurement) {
        result.onContextBuilding = ({ context }) => {
            if (context[envelopIsIntrospectionSymbol]) {
                return;
            }
            // const contextStartTime = process.hrtime();
            const contextStartTime = [0, 0];
            return () => {
                options.onContextBuildingMeasurement(deltaFrom(contextStartTime));
            };
        };
    }
    if (options.onParsingMeasurement) {
        result.onParse = ({ params, extendContext }) => {
            if (options.skipIntrospection && isIntrospectionOperationString(params.source)) {
                extendContext({
                    [envelopIsIntrospectionSymbol]: true,
                });
                return;
            }
            // const parseStartTime = process.hrtime();
            const parseStartTime = [0, 0];
            return () => {
                options.onParsingMeasurement(params.source, deltaFrom(parseStartTime));
            };
        };
    }
    if (options.onValidationMeasurement) {
        result.onValidate = ({ params, context }) => {
            if (context[envelopIsIntrospectionSymbol]) {
                return;
            }
            // const validateStartTime = process.hrtime();
            const validateStartTime = [0, 0];
            return () => {
                options.onValidationMeasurement(params.documentAST, deltaFrom(validateStartTime));
            };
        };
    }
    if (options.onExecutionMeasurement) {
        if (options.onResolverMeasurement) {
            result.onExecute = ({ args }) => {
                if (args.contextValue[envelopIsIntrospectionSymbol]) {
                    return;
                }
                // const executeStartTime = process.hrtime();
                const executeStartTime = [0, 0];
                return {
                    onExecuteDone: () => {
                        options.onExecutionMeasurement(args, deltaFrom(executeStartTime));
                    },
                    onResolverCalled: ({ info }) => {
                        // const resolverStartTime = process.hrtime();
                        const resolverStartTime = [0, 0];
                        return () => {
                            options.onResolverMeasurement(info, deltaFrom(resolverStartTime));
                        };
                    },
                };
            };
        }
        else {
            result.onExecute = ({ args }) => {
                if (args.contextValue[envelopIsIntrospectionSymbol]) {
                    return;
                }
                // const executeStartTime = process.hrtime();
                const executeStartTime = [0, 0];
                return {
                    onExecuteDone: () => {
                        options.onExecutionMeasurement(args, deltaFrom(executeStartTime));
                    },
                };
            };
        }
    }
    if (options.onSubscriptionMeasurement) {
        if (options.onResolverMeasurement) {
            result.onSubscribe = ({ args }) => {
                if (args.contextValue[envelopIsIntrospectionSymbol]) {
                    return;
                }
                // const subscribeStartTime = process.hrtime();
                const subscribeStartTime = [0, 0];
                return {
                    onSubscribeResult: () => {
                        options.onSubscriptionMeasurement && options.onSubscriptionMeasurement(args, deltaFrom(subscribeStartTime));
                    },
                    onResolverCalled: ({ info }) => {
                        // const resolverStartTime = process.hrtime();
                        const resolverStartTime = [0, 0];
                        return () => {
                            options.onResolverMeasurement && options.onResolverMeasurement(info, deltaFrom(resolverStartTime));
                        };
                    },
                };
            };
        }
        else {
            result.onSubscribe = ({ args }) => {
                if (args.contextValue[envelopIsIntrospectionSymbol]) {
                    return;
                }
                // const subscribeStartTime = process.hrtime();
                const subscribeStartTime = [0, 0];
                return {
                    onSubscribeResult: () => {
                        options.onSubscriptionMeasurement && options.onSubscriptionMeasurement(args, deltaFrom(subscribeStartTime));
                    },
                };
            };
        }
    }
    return result;
};

const useSchema = (schema) => {
    return {
        onPluginInit({ setSchema }) {
            setSchema(schema);
        },
    };
};
const useLazyLoadedSchema = (schemaLoader) => {
    return {
        onEnveloped({ setSchema, context }) {
            setSchema(schemaLoader(context));
        },
    };
};
const useAsyncSchema = (schemaPromise) => {
    return {
        onPluginInit({ setSchema }) {
            schemaPromise.then(schemaObj => {
                setSchema(schemaObj);
            });
        },
    };
};

const makeHandleResult = (errorHandler) => ({ result, args }) => {
    var _a;
    if ((_a = result.errors) === null || _a === void 0 ? void 0 : _a.length) {
        errorHandler(result.errors, args);
    }
};
const useErrorHandler = (errorHandler) => ({
    onExecute() {
        const handleResult = makeHandleResult(errorHandler);
        return {
            onExecuteDone(payload) {
                return handleStreamOrSingleExecutionResult(payload, handleResult);
            },
        };
    },
});

const useExtendContext = (contextFactory) => ({
    async onContextBuilding({ context, extendContext }) {
        extendContext((await contextFactory(context)));
    },
});

const makeHandleResult$1 = (formatter) => ({ args, result, setResult, }) => {
    const modified = formatter(result, args);
    if (modified !== false) {
        setResult(modified);
    }
};
const usePayloadFormatter = (formatter) => ({
    onExecute() {
        const handleResult = makeHandleResult$1(formatter);
        return {
            onExecuteDone(payload) {
                return handleStreamOrSingleExecutionResult(payload, handleResult);
            },
        };
    },
});

const DEFAULT_ERROR_MESSAGE = 'Unexpected error.';
class EnvelopError extends GraphQLError {
    constructor(message, extensions) {
        super(message, undefined, undefined, undefined, undefined, undefined, extensions);
    }
}
const formatError = (err, message, isDev) => {
    if (err instanceof GraphQLError) {
        if (err.originalError && err.originalError instanceof EnvelopError === false) {
            return new GraphQLError(message, err.nodes, err.source, err.positions, err.path, undefined, isDev
                ? {
                    originalError: {
                        message: err.originalError.message,
                        stack: err.originalError.stack,
                    },
                }
                : undefined);
        }
        return err;
    }
    return new GraphQLError(message);
};
const makeHandleResult$2 = (format, message, isDev) => ({ result, setResult }) => {
    if (result.errors != null) {
        setResult({ ...result, errors: result.errors.map(error => format(error, message, isDev)) });
    }
};
const useMaskedErrors = (opts) => {
    var _a, _b;
    const format = (_a = opts === null || opts === void 0 ? void 0 : opts.formatError) !== null && _a !== void 0 ? _a : formatError;
    const message = (opts === null || opts === void 0 ? void 0 : opts.errorMessage) || DEFAULT_ERROR_MESSAGE;
    // eslint-disable-next-line dot-notation
    const isDev = (_b = opts === null || opts === void 0 ? void 0 : opts.isDev) !== null && _b !== void 0 ? _b : (typeof process !== 'undefined' ? process.env['NODE_ENV'] === 'development' : false);
    const handleResult = makeHandleResult$2(format, message, isDev);
    return {
        onPluginInit(context) {
            context.registerContextErrorHandler(({ error, setError }) => {
                setError(formatError(error, message, isDev));
            });
        },
        onExecute() {
            return {
                onExecuteDone(payload) {
                    return handleStreamOrSingleExecutionResult(payload, handleResult);
                },
            };
        },
        onSubscribe() {
            return {
                onSubscribeResult(payload) {
                    return handleStreamOrSingleExecutionResult(payload, handleResult);
                },
                onSubscribeError({ error, setError }) {
                    setError(formatError(error, message, isDev));
                },
            };
        },
    };
};

export { DEFAULT_ERROR_MESSAGE, EnvelopError, enableIf, envelop, envelopIsIntrospectionSymbol, errorAsyncIterator, finalAsyncIterator, formatError, handleStreamOrSingleExecutionResult, isAsyncIterable, isIntrospectionDocument, isIntrospectionOperation, isIntrospectionOperationString, isOperationDefinition, isPluginEnabled, makeExecute, makeSubscribe, mapAsyncIterator, useAsyncSchema, useEnvelop, useErrorHandler, useExtendContext, useLazyLoadedSchema, useLogger, useMaskedErrors, usePayloadFormatter, useSchema, useTiming };

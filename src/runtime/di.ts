import { PLATFORM } from './platform';
import { Injectable, Constructable, IIndexable } from './interfaces';
import { Reporter } from './reporter';

type ResolveCallback<T = any> = (handler?: IContainer, requestor?: IContainer, resolver?: IResolver) => T;

export interface IInterfaceSymbol<T> {
  (target: Injectable, property: string, index: number): any;
}

interface IDefaultableInterfaceSymbol<T> extends IInterfaceSymbol<T> {
  withDefault(configure: (builder: IResolverBuilder<T>) => IResolver): IInterfaceSymbol<T>;
}

export interface IResolver<T = any> {
  resolve(handler: IContainer, requestor: IContainer): T;
  getFactory?(container: IContainer): IFactory<T>;
}

export interface IRegistration<T = any> {
  register(container: IContainer, key?: any): IResolver<T>;
}

export interface IFactory<T = any> {
  registerTransformer(transformer: (instance: T) => T): boolean;
  construct(container: IContainer, dynamicDependencies?: any[]): T;
}

export interface IServiceLocator {
  get<T>(key: IInterfaceSymbol<T>): T;
  get<T extends Constructable>(key: T): InstanceType<T>
  get<T = any>(key: any): T;

  getAll<T>(key: IInterfaceSymbol<T>): ReadonlyArray<T>;
  getAll<T extends Constructable>(key: T): ReadonlyArray<InstanceType<T>>;
  getAll<T = any>(key: any): ReadonlyArray<T>;
}

export interface IRegistry {
  register(container: IContainer): void;
}

export interface IContainer extends IServiceLocator {
  register(...params: (IRegistry | Record<string, Partial<IRegistry>>)[]);

  registerResolver<T>(key: IInterfaceSymbol<T>, resolver: IResolver<T>): IResolver<T>;
  registerResolver<T extends Constructable>(key: T, resolver: IResolver<InstanceType<T>>): IResolver<InstanceType<T>>;
  registerResolver<T = any>(key: any, resolver: IResolver<T>): IResolver<T>;

  registerTransformer<T>(key: IInterfaceSymbol<T>, transformer: (instance: T) => T): boolean;
  registerTransformer<T extends Constructable>(key: T, transformer: (instance: InstanceType<T>) => T): boolean;
  registerTransformer<T = any>(key: any, transformer: (instance: T) => T): boolean;

  getResolver<T>(key: IInterfaceSymbol<T>, autoRegister?: boolean): IResolver<T>;
  getResolver<T extends Constructable>(key: T, autoRegister?: boolean): IResolver<InstanceType<T>>;
  getResolver<T = any>(key: any, autoRegister?: boolean): IResolver<T>;

  getFactory<T extends Constructable>(type: T): IFactory<InstanceType<T>>;

  createChild(): IContainer;
}

interface IResolverBuilder<T> {
  instance(value: T & IIndexable): IResolver;
  singleton(value: Constructable<T>): IResolver;
  transient(value: Constructable<T>): IResolver;
  callback(value: ResolveCallback<T>): IResolver;
  aliasTo(destinationKey: any): IResolver;
}

if (!('getOwnMetadata' in Reflect)) {
  (<any>Reflect).getOwnMetadata = function(key, target) {
    return target[key];
  };

  (<any>Reflect).metadata = function(key, value) {
    return function(target) {
      target[key] = value;
    }
  };
}

export const DI = { 
  createContainer(): IContainer {
    return new Container();
  },
  getDesignParamTypes(target: any): any[] {
    return (<any>Reflect).getOwnMetadata('design:paramtypes', target) || PLATFORM.emptyArray;
  },
  getDependencies(type: Function): any[] {
    let dependencies: any[];

    if ((<any>type).inject === undefined) {
      dependencies = DI.getDesignParamTypes(type);
    } else {
      dependencies = [];
      let ctor = type;

      while (typeof ctor === 'function') {
        if (ctor.hasOwnProperty('inject')) {
          dependencies.push(...(<any>ctor).inject);
        }
        
        ctor = Object.getPrototypeOf(ctor);
      }
    }

    return dependencies;
  },
  createInterface<T = any>(friendlyName?: string): IDefaultableInterfaceSymbol<T> {
    const Key: any = function(target: Injectable, property: string, index: number): any {
      const inject = target.inject || (target.inject = []);
      (<any>Key).friendlyName = friendlyName || 'Interface';
      inject[index] = Key;
      return target;
    };
  
    Key.withDefault = function(configure: (builder: IResolverBuilder<T>) => IResolver): IInterfaceSymbol<T> {
      Key.withDefault = function() {
        throw Reporter.error(17, Key);
      };

      Key.register = function(container: IContainer, key?: any) {
        return configure({
          instance(value: any) { 
            return container.registerResolver(Key, new Resolver(key || Key, ResolverStrategy.instance, value));
          },
          singleton(value: Function) { 
            return container.registerResolver(Key, new Resolver(key || Key, ResolverStrategy.singleton, value));
          },
          transient(value: Function) { 
            return container.registerResolver(Key, new Resolver(key || Key, ResolverStrategy.transient, value));
          },
          callback(value: ResolveCallback) { 
            return container.registerResolver(Key, new Resolver(key || Key, ResolverStrategy.callback, value));
          },
          aliasTo(destinationKey: any) { 
            return container.registerResolver(destinationKey, new Resolver(key || Key, ResolverStrategy.alias, Key));
          },
        });
      }
  
      return Key;
    };
  
    return Key;
  }
};

export const IContainer = <IInterfaceSymbol<IContainer>>DI.createInterface<IContainer>();
export const IServiceLocator = <IInterfaceSymbol<IServiceLocator>>IContainer;

const enum ResolverStrategy {
  instance = 0,
  singleton = 1,
  transient = 2,
  callback = 3,
  array = 4,
  alias = 5
}

class Resolver implements IResolver, IRegistration {
  constructor(public key: any, public strategy: ResolverStrategy, public state: any) {}

  register(container: IContainer, key?: any) {
    return container.registerResolver(key || this.key, this);
  }

  resolve(handler: IContainer, requestor: IContainer): any {
    switch (this.strategy) {
      case ResolverStrategy.instance:
        return this.state;
      case ResolverStrategy.singleton:
        this.strategy = ResolverStrategy.instance;
        return this.state = handler.getFactory(this.state).construct(handler);
      case ResolverStrategy.transient:
        //always create transients from the requesting container
        return handler.getFactory(this.state).construct(requestor);
      case ResolverStrategy.callback:
        return (<ResolveCallback>this.state)(handler, requestor, this);
      case ResolverStrategy.array:
        return this.state[0].get(handler, requestor);
      case ResolverStrategy.alias:
        return handler.get(this.state);
      default:
        throw Reporter.error(6, this.strategy);
    }
  }

  getFactory(container: IContainer): IFactory {
    switch (this.strategy) {
      case ResolverStrategy.singleton:
      case ResolverStrategy.transient:
        return container.getFactory(this.state);
      default:
        return null;
    }
  }
}

interface IInvoker {
  invoke(container: IContainer, fn: Function, dependencies: any[]): any;
  invokeWithDynamicDependencies(container: IContainer, fn: Function, staticDependencies: any[], dynamicDependencies: any[]): any;
}

class Factory implements IFactory {
  private transformers: ((instance: any) => any)[] = null;

  constructor(private fn: Function, private invoker: IInvoker, private dependencies: any[]) { }

  construct(container: IContainer, dynamicDependencies?: any[]): any {
    let transformers = this.transformers;
    let instance = dynamicDependencies !== undefined
      ? this.invoker.invokeWithDynamicDependencies(container, this.fn, this.dependencies, dynamicDependencies)
      : this.invoker.invoke(container, this.fn, this.dependencies);

    if (transformers === null) {
      return instance;
    }

    for (let i = 0, ii = transformers.length; i < ii; ++i) {
      instance = transformers[i](instance);
    }

    return instance;
  }

  registerTransformer(transformer: (instance: any) => any): boolean {
    if (this.transformers === null) {
      this.transformers = [];
    }

    this.transformers.push(transformer);
    return true;
  }

  static create(fn: Function & { inject?: any }): IFactory {
    const dependencies = DI.getDependencies(fn);
    const invoker = classInvokers[dependencies.length] || classInvokers.fallback;
    return new Factory(fn, invoker, dependencies);
  }
}

interface IContainerConfiguration {
  factories?: Map<Function, any>;
}

const containerResolver: IResolver = {
  resolve(handler: IContainer, requestor: IContainer) {
    return requestor;
  }
};

function isRegistry(obj: any): obj is IRegistry {
  return typeof obj.register === 'function';
}

class Container implements IContainer {
  private parent: Container = null;
  private resolvers = new Map<any, IResolver>();
  private factories: Map<Function, any>;
  private configuration: IContainerConfiguration;

  constructor(configuration: IContainerConfiguration = {}) {
    this.configuration = configuration;
    this.factories = configuration.factories || (configuration.factories = new Map());
    this.resolvers.set(IContainer, containerResolver);
  }

  register(...params: (IRegistry | Record<string, Partial<IRegistry>>)[]) {
    const resolvers = this.resolvers;

    for (let i = 0, ii = params.length; i < ii; ++i) {
      const current = params[i];
      
      if (isRegistry(current)) {
        current.register(this);
      } else {
        Object.keys(current).forEach(key => {
          const value = current[key];

          if (value.register) {
            value.register(this);
          }
        });
      }
    }
  }

  registerResolver(key: any, resolver: IResolver): IResolver {
    validateKey(key);

    const resolvers = this.resolvers;
    const result = resolvers.get(key);

    if (result === undefined) {
      resolvers.set(key, resolver);
    } else if (resolver instanceof Resolver && (<Resolver>resolver).strategy === 4) {
      (<Resolver>result).state.push(resolver);
    } else {
      resolvers.set(key, new Resolver(key, 4, [result, resolver]));
    }

    return resolver;
  }

  registerTransformer(key: any, transformer: (instance: any) => any): boolean {
    let resolver = this.getResolver(key);

    if (resolver === null) {
      return false;
    }

    if (resolver.getFactory) {
      let handler = resolver.getFactory(this);

      if (handler === null) {
        return false;
      }
      
      return handler.registerTransformer(transformer);
    }

    return false;
  }

  getResolver(key: any, autoRegister = true): IResolver | null {
    validateKey(key);

    if (key.resolve) {
      return key;
    }

    let current: Container = this;

    while (current !== null) {
      const resolver = current.resolvers.get(key);

      if (resolver === undefined) {
        if (current.parent === null) {
          return autoRegister ? this.jitRegister(key, current) : null;
        }

        current = current.parent;
      } else {
        return resolver;
      }
    }

    return null;
  }

  get(key: any) {
    validateKey(key);

    if (key.resolve) {
      return key.resolve(this, this);
    }

    let current: Container = this;

    while (current !== null) {
      const resolver = current.resolvers.get(key);

      if (resolver === undefined) {
        if (current.parent === null) {
          return this.jitRegister(key, current).resolve(current, this);
        }
  
        current = current.parent;
      } else {
        return resolver.resolve(current, this);
      }
    }
  }

  getAll(key: any): ReadonlyArray<any> {
    validateKey(key);

    let current: Container = this;

    while (current !== null) {
      const resolver = current.resolvers.get(key);

      if (resolver === undefined) {
        if (this.parent === null) {
          return PLATFORM.emptyArray;
        } 
        
        current = current.parent;
      } else {
        return buildAllResponse(resolver, current, this);
      }
    }
  }

  private jitRegister(keyAsValue: any, handler: Container): IResolver {
    if (keyAsValue.register) {
      return keyAsValue.register(handler, keyAsValue);
    }

    const resolver = new Resolver(keyAsValue, 1, keyAsValue);
    handler.resolvers.set(keyAsValue, resolver);
    return resolver;
  }

  getFactory(type: Function): IFactory {
    let factory = this.factories.get(type);

    if (factory === undefined) {
      factory = Factory.create(type);
      this.factories.set(type, factory);
    }

    return factory;
  }

  createChild(): IContainer {
    const child = new Container(this.configuration);
    child.parent = this;
    return child;
  }
}

export const Registration = {
  instance(key: any, value: any): IRegistration {
    return new Resolver(key, ResolverStrategy.instance, value);
  },

  singleton(key: any, value: Function): IRegistration {
    return new Resolver(key, ResolverStrategy.singleton, value);
  },

  transient(key: any, value: Function): IRegistration {
    return new Resolver(key, ResolverStrategy.transient, value);
  },

  callback(key: any, callback: ResolveCallback): IRegistration {
    return new Resolver(key, ResolverStrategy.callback, callback);
  },

  alias(originalKey: any, aliasKey: any): IRegistration {
    return new Resolver(aliasKey, ResolverStrategy.alias, originalKey);
  },

  interpret(interpreterKey: any, ...rest: any[]): IRegistry {
    return {
      register(container: IContainer) {
        let registry: IRegistry;
        const resolver = container.getResolver<IRegistry>(interpreterKey);

        if (resolver.getFactory) {
          registry = resolver.getFactory(container).construct(container, rest);
        } else {
          registry = resolver.resolve(container, container);
        }

        registry.register(container);
      }
    };
  }
};

function validateKey(key: any) {
  if (key === null || key === undefined) {
    throw Reporter.error(5);
  }
}

function buildAllResponse(resolver: IResolver, handler: IContainer, requestor: IContainer) {
  if (resolver instanceof Resolver && resolver.strategy === 4) {
    const state = resolver.state;
    let i = state.length;
    const results = new Array(i);

    while (i--) {
      results[i] = state[i].get(handler, requestor);
    }

    return results;
  }

  return [resolver.resolve(handler, requestor)];
}

const classInvokers: Record<string, IInvoker> = {
  [0]: {
    invoke(container: IContainer, Type: Function) {
      return new (<any>Type)();
    },
    invokeWithDynamicDependencies: invokeWithDynamicDependencies
  },
  [1]: {
    invoke(container: IContainer, Type: Function, deps: any[]) {
      return new (<any>Type)(container.get(deps[0]));
    },
    invokeWithDynamicDependencies: invokeWithDynamicDependencies
  },
  [2]: {
    invoke(container: IContainer, Type: Function, deps: any[]) {
      return new (<any>Type)(container.get(deps[0]), container.get(deps[1]));
    },
    invokeWithDynamicDependencies: invokeWithDynamicDependencies
  },
  [3]: {
    invoke(container: IContainer, Type: Function, deps: any[]) {
      return new (<any>Type)(container.get(deps[0]), container.get(deps[1]), container.get(deps[2]));
    },
    invokeWithDynamicDependencies: invokeWithDynamicDependencies
  },
  [4]: {
    invoke(container: IContainer, Type: Function, deps: any[]) {
      return new (<any>Type)(container.get(deps[0]), container.get(deps[1]), container.get(deps[2]), container.get(deps[3]));
    },
    invokeWithDynamicDependencies: invokeWithDynamicDependencies
  },
  [5]: {
    invoke(container: IContainer, Type: Function, deps: any[]) {
      return new (<any>Type)(container.get(deps[0]), container.get(deps[1]), container.get(deps[2]), container.get(deps[3]), container.get(deps[4]));
    },
    invokeWithDynamicDependencies: invokeWithDynamicDependencies
  },
  fallback: {
    invoke: <any>invokeWithDynamicDependencies,
    invokeWithDynamicDependencies: invokeWithDynamicDependencies
  }
};

function invokeWithDynamicDependencies(container: IContainer, fn: Function, staticDependencies, dynamicDependencies) {
  let i = staticDependencies.length;
  let args = new Array(i);
  let lookup;

  while (i--) {
    lookup = staticDependencies[i];

    if (lookup === null || lookup === undefined) {
      throw Reporter.error(7, `Index ${i}.`);
    } else {
      args[i] = container.get(lookup);
    }
  }

  if (dynamicDependencies !== undefined) {
    args = args.concat(dynamicDependencies);
  }

  return Reflect.construct(fn, args);
}

/**
* Decorator: Directs the TypeScript transpiler to write-out type metadata for the decorated class.
*/
export function autoinject<T extends Injectable>(potentialTarget?: T): any {
  let deco = function<T extends Injectable>(target: T) {
    let previousInject = target.inject ? target.inject.slice() : null; //make a copy of target.inject to avoid changing parent inject
    let autoInject: any = DI.getDesignParamTypes(target);
    
    if (!previousInject) {
      target.inject = autoInject;
    } else {
      for (let i = 0; i < autoInject.length; i++) {
        //check if previously injected.
        if (previousInject[i] && previousInject[i] !== autoInject[i]) {
          const prevIndex = previousInject.indexOf(autoInject[i]);
          if (prevIndex > -1) {
            previousInject.splice(prevIndex, 1);
          }
          previousInject.splice((prevIndex > -1 && prevIndex < i) ? i - 1 : i, 0, autoInject[i]);
        } else if (!previousInject[i]) {//else add
          previousInject[i] = autoInject[i];
        }
      }

      target.inject = previousInject;
    }
  };

  return potentialTarget ? deco(potentialTarget) : deco;
}

/**
* Decorator: Specifies the dependencies that should be injected by the DI Container into the decoratored class/function.
*/
export function inject(...rest: any[]): any {
  return function<T extends Injectable>(target: T, key?, descriptor?) {
    // handle when used as a parameter
    if (typeof descriptor === 'number' && rest.length === 1) {
      let params = target.inject;

      if (!params) {
        params = DI.getDesignParamTypes(target).slice();
        target.inject = params;
      }

      params[descriptor] = rest[0];
      return;
    }

    // if it's true then we injecting rest into function and not Class constructor
    if (descriptor) {
      const fn = descriptor.value;
      fn.inject = rest;
    } else {
      target.inject = rest;
    }
  };
}

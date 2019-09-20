import { DI, IContainer, Key, Reporter } from '@aurelia/kernel';
import { Aurelia, CustomElement, IController, IRenderContext } from '@aurelia/runtime';
import { BrowserNavigator } from './browser-navigator';
import { Guardian, GuardTypes } from './guardian';
import { InstructionResolver, IRouteSeparators } from './instruction-resolver';
import { ComponentAppellation, INavigatorInstruction, IRouteableComponent, NavigationInstruction, ViewportHandle } from './interfaces';
import { AnchorEventInfo, LinkHandler } from './link-handler';
import { INavRoute, Nav } from './nav';
import { INavigatorEntry, INavigatorFlags, INavigatorOptions, INavigatorViewerEvent, Navigator } from './navigator';
import { IParsedQuery, parseQuery } from './parser';
import { QueueItem } from './queue';
import { INavClasses } from './resources/nav';
import { RouteTable } from './route-table';
import { Scope } from './scope';
import { NavigationInstructionResolver } from './type-resolvers';
import { arrayRemove } from './utils';
import { IViewportOptions, Viewport } from './viewport';
import { ViewportInstruction } from './viewport-instruction';

export interface IRouteTransformer {
  transformFromUrl?(route: string, router: IRouter): string | ViewportInstruction[];
  transformToUrl?(instructions: ViewportInstruction[], router: IRouter): string | ViewportInstruction[];
}

export const IRouteTransformer = DI.createInterface<IRouteTransformer>('IRouteTransformer').withDefault(x => x.singleton(RouteTable));

export interface IGotoOptions {
  title?: string;
  query?: string;
  data?: Record<string, unknown>;
  replace?: boolean;
  append?: boolean;
  origin?: IRouteableComponent | Element;
}

export interface IRouterOptions extends INavigatorOptions, IRouteTransformer {
  separators?: IRouteSeparators;
  useUrlFragmentHash?: boolean;
  statefulHistory?: boolean;
  reportCallback?(instruction: INavigatorInstruction): void;
}

export interface IRouter {
  readonly isNavigating: boolean;
  activeComponents: ViewportInstruction[];
  readonly container: IContainer;
  readonly scopes: Scope[];
  readonly instructionResolver: InstructionResolver;
  navigator: Navigator;
  readonly navigation: BrowserNavigator;
  readonly guardian: Guardian;
  readonly navs: Readonly<Record<string, Nav>>;
  readonly options: IRouterOptions;

  activate(options?: IRouterOptions): void;
  loadUrl(): Promise<void>;
  deactivate(): void;

  linkCallback(info: AnchorEventInfo): void;

  processNavigations(qInstruction: QueueItem<INavigatorInstruction>): Promise<void>;
  // addProcessingViewport(componentOrInstruction: ComponentAppellation | ViewportInstruction, viewport?: ViewportHandle, onlyIfProcessingStatus?: boolean): void;

  // External API to get viewport by name
  getViewport(name: string): Viewport | null;

  // Called from the viewport custom element in attached()
  addViewport(name: string, element: Element, context: IRenderContext, options?: IViewportOptions): Viewport;
  // Called from the viewport custom element
  removeViewport(viewport: Viewport, element: Element | null, context: IRenderContext | null): void;

  allViewports(): Viewport[];
  findScope(element: Element | null): Scope;
  removeScope(scope: Scope): void;

  // goto(pathOrViewports: string | Record<string, Viewport>, title?: string, data?: Record<string, unknown>): Promise<void>;
  goto(instructions: NavigationInstruction | NavigationInstruction[], options?: IGotoOptions): Promise<void>;
  refresh(): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;

  setNav(name: string, routes: INavRoute[], classes?: INavClasses): void;
  addNav(name: string, routes: INavRoute[], classes?: INavClasses): void;
  updateNav(name?: string): void;
  findNav(name: string): Nav;
  closestViewport(element: Element): Viewport | null;
}

export const IRouter = DI.createInterface<IRouter>('IRouter').withDefault(x => x.singleton(Router));

export class Router implements IRouter {
  public static readonly inject: readonly Key[] = [IContainer, Navigator, BrowserNavigator, IRouteTransformer, LinkHandler, InstructionResolver];

  public rootScope: Scope | null = null;
  public scopes: Scope[] = [];

  public guardian: Guardian;

  public navs: Record<string, Nav> = {};
  public activeComponents: ViewportInstruction[] = [];

  public addedViewports: ViewportInstruction[] = [];

  public options: IRouterOptions = {};
  private isActive: boolean = false;
  private loadedFirst: boolean = false;

  private processingNavigation: INavigatorInstruction | null = null;
  private lastNavigation: INavigatorInstruction | null = null;

  constructor(
    public readonly container: IContainer,
    public navigator: Navigator,
    public navigation: BrowserNavigator,
    private readonly routeTransformer: IRouteTransformer,
    public linkHandler: LinkHandler,
    public instructionResolver: InstructionResolver
  ) {
    this.guardian = new Guardian();
  }

  public get isNavigating(): boolean {
    return this.processingNavigation !== null;
  }

  public activate(options?: IRouterOptions): void {
    if (this.isActive) {
      throw new Error('Router has already been activated');
    }

    this.isActive = true;
    this.options = {
      ...{
        transformFromUrl: this.routeTransformer.transformFromUrl,
        transformToUrl: this.routeTransformer.transformToUrl,
        statefulHistory: true,
      }, ...options
    };

    this.instructionResolver.activate({ separators: this.options.separators });
    this.navigator.activate(this, {
      callback: this.navigatorCallback,
      store: this.navigation,
    });
    this.linkHandler.activate({ callback: this.linkCallback });
    this.navigation.activate({
      callback: this.browserNavigatorCallback,
      useUrlFragmentHash: this.options.useUrlFragmentHash
    });
  }

  public loadUrl(): Promise<void> {
    const entry: INavigatorEntry = {
      ...this.navigation.viewerState,
      ...{
        fullStateInstruction: '',
        replacing: true,
        fromBrowser: false,
      }
    };
    const result = this.navigator.navigate(entry);
    this.loadedFirst = true;
    return result;
  }

  public deactivate(): void {
    if (!this.isActive) {
      throw new Error('Router has not been activated');
    }
    this.linkHandler.deactivate();
    this.navigator.deactivate();
    this.navigation.deactivate();
  }

  public linkCallback = (info: AnchorEventInfo): void => {
    let href = info.href || '';
    if (href.startsWith('#')) {
      href = href.slice(1);
      // '#' === '/' === '#/'
      if (!href.startsWith('/')) {
        href = `/${href}`;
      }
    }
    // Adds to Navigator's Queue, which makes sure it's serial
    this.goto(href, { origin: info.anchor! }).catch(error => { throw error; });
  }

  public navigatorCallback = (instruction: INavigatorInstruction): void => {
    // Instructions extracted from queue, one at a time
    this.processNavigations(instruction).catch(error => { throw error; });
  }
  public browserNavigatorCallback = (browserNavigationEvent: INavigatorViewerEvent): void => {
    const entry: INavigatorEntry = (browserNavigationEvent.state && browserNavigationEvent.state.currentEntry
      ? browserNavigationEvent.state.currentEntry as INavigatorEntry
      : { instruction: '', fullStateInstruction: '' });
    entry.instruction = browserNavigationEvent.instruction;
    entry.fromBrowser = true;
    this.navigator.navigate(entry).catch(error => { throw error; });
  }

  public processNavigations = async (qInstruction: QueueItem<INavigatorInstruction>): Promise<void> => {
    const instruction: INavigatorInstruction = this.processingNavigation = qInstruction as INavigatorInstruction;

    if (this.options.reportCallback) {
      this.options.reportCallback(instruction);
    }

    let fullStateInstruction: boolean = false;
    const instructionNavigation: INavigatorFlags = instruction.navigation as INavigatorFlags;
    if ((instructionNavigation.back || instructionNavigation.forward) && instruction.fullStateInstruction) {
      fullStateInstruction = true;
      // tslint:disable-next-line:no-commented-code
      // if (!confirm('Perform history navigation?')) {
      //   this.navigator.cancel(instruction);
      //   this.processingNavigation = null;
      //   return Promise.resolve();
      // }
    }

    let instructions: ViewportInstruction[];
    let clearUsedViewports: boolean = fullStateInstruction;
    if (typeof instruction.instruction === 'string') {
      let path = instruction.instruction;
      let transformedInstruction: string | ViewportInstruction[] = path;
      if (this.options.transformFromUrl && !fullStateInstruction) {
        transformedInstruction = this.options.transformFromUrl(path, this);
      }
      if (Array.isArray(transformedInstruction)) {
        instructions = transformedInstruction;
      } else {
        path = transformedInstruction;
        // TODO: Review this
        if (path === '/') {
          path = '';
        }

        instructions = this.instructionResolver.parseViewportInstructions(path);
        // TODO: Used to have an early exit if no instructions. Restore it?
      }
    } else {
      instructions = instruction.instruction;
      // TODO: Used to have an early exit if no instructions. Restore it?
    }

    if (instructions.some(instr => this.instructionResolver.isClearAllViewportsInstruction(instr))) {
      clearUsedViewports = true;
      instructions = instructions.filter(instr => !this.instructionResolver.isClearAllViewportsInstruction(instr));
    }

    const parsedQuery: IParsedQuery = parseQuery(instruction.query);
    instruction.parameters = parsedQuery.parameters;
    instruction.parameterList = parsedQuery.list;

    // TODO: Fetch title (probably when done)

    let clearViewports = (clearUsedViewports ? this.allViewports().filter((value) => value.content.componentInstance !== null) : []);
    const doneDefaultViewports: Viewport[] = [];
    let defaultViewports = this.allViewports().filter(viewport =>
      viewport.options.default
      && viewport.content.componentInstance === null
      && doneDefaultViewports.every(done => done !== viewport)
    );
    const updatedViewports: Viewport[] = [];

    for (const instr of instructions) {
      if (instr.scope === null) {
        instr.scope = this.rootScope;
      }
    }

    const alreadyFoundInstructions: ViewportInstruction[] = [];
    // TODO: Take care of cancellations down in subsets/iterations
    let { found: viewportInstructions, remaining: remainingInstructions } = this.findViewports(instructions, alreadyFoundInstructions);
    let guard = 100;
    while (viewportInstructions.length || remainingInstructions.length || defaultViewports.length || clearUsedViewports) {
      // Guard against endless loop
      if (!guard--) {
        throw Reporter.error(2002);
      }

      for (const defaultViewport of defaultViewports) {
        doneDefaultViewports.push(defaultViewport);
        if (viewportInstructions.every(value => value.viewport !== defaultViewport)) {
          const defaultInstruction = this.instructionResolver.parseViewportInstruction(defaultViewport.options.default as string);
          defaultInstruction.viewport = defaultViewport;
          viewportInstructions.push(defaultInstruction);
        }
      }

      const changedViewports: Viewport[] = [];

      const outcome = this.guardian.passes(GuardTypes.Before, viewportInstructions, instruction);
      if (!outcome) {
        return this.cancelNavigation([...changedViewports, ...updatedViewports], instruction);
      }
      if (typeof outcome !== 'boolean') {
        viewportInstructions = outcome;
      }

      for (const viewportInstruction of viewportInstructions) {
        const viewport: Viewport = viewportInstruction.viewport as Viewport;
        if (viewport.setNextContent(viewportInstruction, instruction)) {
          changedViewports.push(viewport);
        }
        arrayRemove(clearViewports, value => value === viewport);
      }

      let results = await Promise.all(changedViewports.map((value) => value.canLeave()));
      if (results.some(result => result === false)) {
        return this.cancelNavigation([...changedViewports, ...updatedViewports], instruction);
      }

      results = await Promise.all(changedViewports.map(async (value) => {
        const canEnter = await value.canEnter();
        if (typeof canEnter === 'boolean') {
          if (canEnter) {
            return value.enter();
          } else {
            return false;
          }
        }
        await this.goto(canEnter, { append: true });
        await value.abortContentChange();
        // for (const viewportInstruction of canEnter) {
        //   // TODO: Abort content change in the viewports
        //   this.addProcessingViewport(viewportInstruction);
        // }
        // value.abortContentChange().catch(error => { throw error; });
        return true;
      }));
      if (results.some(result => result === false)) {
        return this.cancelNavigation([...changedViewports, ...updatedViewports], qInstruction);
      }

      for (const viewport of changedViewports) {
        if (updatedViewports.every(value => value !== viewport)) {
          updatedViewports.push(viewport);
        }
      }

      // TODO: Fix multi level recursiveness!
      alreadyFoundInstructions.push(...viewportInstructions);
      const remaining = this.findViewports(remainingInstructions, alreadyFoundInstructions);
      viewportInstructions = [];
      let addedViewport: ViewportInstruction;
      while (addedViewport = this.addedViewports.shift() as ViewportInstruction) {
        // TODO: Should this overwrite instead? I think so.
        if (remaining.found.every(value => value.viewport !== addedViewport.viewport)) {
          viewportInstructions.push(addedViewport);
        }
      }
      viewportInstructions = [...viewportInstructions, ...remaining.found];
      remainingInstructions = remaining.remaining;
      defaultViewports = this.allViewports().filter(viewport =>
        viewport.options.default
        && viewport.content.componentInstance === null
        && doneDefaultViewports.every(done => done !== viewport)
        && updatedViewports.every(updated => updated !== viewport)
      );

      // clearViewports is empty if we're not clearing viewports
      if (viewportInstructions.length === 0 &&
        remainingInstructions.length === 0 &&
        defaultViewports.length === 0) {
        viewportInstructions = [
          ...viewportInstructions,
          ...clearViewports.map(viewport => new ViewportInstruction(this.instructionResolver.clearViewportInstruction, viewport))
        ];
        clearViewports = [];
        // for (const viewport of clearViewports) {
        //   viewport.setNextContent(this.instructionResolver.clearViewportInstruction, instruction);
        //   // if (viewport.setNextContent(this.instructionResolver.clearViewportInstruction, instruction)) {
        //   //   changedViewports.push(viewport);
        //   // }
        // }
        // let clearResults = await Promise.all(clearViewports.map((value) => value.canLeave()));
        // if (clearResults.some(result => result === false)) {
        //   return this.cancelNavigation([...clearViewports, ...updatedViewports], instruction);
        // }

        // clearResults = await Promise.all(clearViewports.map(async (value) => {
        //   await value.canEnter();
        //   return value.enter();
        // }));
        // if (clearResults.some(result => result === false)) {
        //   return this.cancelNavigation([...clearViewports, ...updatedViewports], qInstruction);
        // }

        // for (const viewport of clearViewports) {
        //   if (updatedViewports.every(value => value !== viewport)) {
        //     updatedViewports.push(viewport);
        //   }
        // }
      }

      // if (!this.allViewports().length) {
      //   viewportsRemaining = false;
      // }
      clearUsedViewports = false;
    }

    await Promise.all(updatedViewports.map((value) => value.loadContent()));
    await this.replacePaths(instruction);
    this.updateNav();

    // Remove history entry if no history viewports updated
    if (instructionNavigation.new && !instructionNavigation.first && !instruction.repeating && updatedViewports.every(viewport => viewport.options.noHistory)) {
      instruction.untracked = true;
    }

    updatedViewports.forEach((viewport) => {
      viewport.finalizeContentChange();
    });
    this.lastNavigation = this.processingNavigation;
    if (this.lastNavigation.repeating) {
      this.lastNavigation.repeating = false;
    }
    this.processingNavigation = null;
    await this.navigator.finalize(instruction);
  }

  // public addProcessingViewport(componentOrInstruction: ComponentAppellation | ViewportInstruction, viewport?: ViewportHandle, onlyIfProcessingStatus?: boolean): void {
  //   if (!this.processingNavigation && onlyIfProcessingStatus) {
  //     return;
  //   }
  //   if (this.processingNavigation) {
  //     const viewportInstruction = NavigationInstructionResolver.toViewportInstructions(this, componentOrInstruction)[0];
  //     if (!viewportInstruction.viewport && viewport) {
  //       viewportInstruction.setViewport(viewport);
  //       if (!viewportInstruction.viewport) {
  //         const viewportInstance = this.allViewports().find(vp => vp.name === viewportInstruction.viewportName);
  //         // TODO: Deal with not yet existing viewports
  //         if (viewportInstance) {
  //           viewportInstruction.setViewport(viewportInstance);
  //         }
  //       }
  //     }
  //     this.addedViewports.push(viewportInstruction);
  //   } else if (this.lastNavigation) {
  //     this.navigator.navigate({ instruction: '', fullStateInstruction: '', repeating: true }).catch(error => { throw error; });
  //     // Don't wait for the (possibly slow) navigation
  //   }
  // }

  public findScope(element: Element): Scope {
    this.ensureRootScope();
    return this.closestScope(element);
  }

  // External API to get viewport by name
  public getViewport(name: string): Viewport | null {
    return this.allViewports().find(viewport => viewport.name === name) || null;
  }

  // Called from the viewport custom element in attached()
  public addViewport(name: string, element: Element, context: IRenderContext, options?: IViewportOptions): Viewport {
    Reporter.write(10000, 'Viewport added', name, element);
    const parentScope = this.findScope(element);
    return parentScope.addViewport(name, element, context, options);
  }
  // Called from the viewport custom element
  public removeViewport(viewport: Viewport, element: Element | null, context: IRenderContext | null): void {
    const scope = viewport.owningScope;
    if (!scope.removeViewport(viewport, element, context)) {
      throw new Error(`Failed to remove viewport: ${viewport.name}`);
    }
  }
  public allViewports(): Viewport[] {
    this.ensureRootScope();
    return (this.rootScope as Scope).allViewports();
  }

  public removeScope(scope: Scope): void {
    if (scope !== this.rootScope) {
      scope.removeScope();
      const index = this.scopes.indexOf(scope);
      if (index >= 0) {
        this.scopes.splice(index, 1);
      }
    }
  }

  public goto(instructions: NavigationInstruction | NavigationInstruction[], options?: IGotoOptions): Promise<void> {
    options = options || {};
    // TODO: Review query extraction; different pos for path and fragment!
    if (typeof instructions === 'string' && !options.query) {
      const [path, search] = instructions.split('?');
      instructions = path;
      options.query = search;
    }
    if (typeof instructions !== 'string' || instructions !== this.instructionResolver.clearViewportInstruction) {
      let scope = null;
      if (options.origin) {
        scope = this.closestScope(options.origin as Element);
        if (typeof instructions === 'string') {
          // If it's not from scope root, figure out which scope
          if (!instructions.startsWith('/')) {
            // Scope modifications
            if (instructions.startsWith('.')) {
              // The same as no scope modification
              if (instructions.startsWith('./')) {
                instructions = instructions.slice(2);
              }
              // Find out how many scopes upwards we should move
              while (instructions.startsWith('../')) {
                scope = scope.parent || scope;
                instructions = instructions.slice(3);
              }
            }
          } else { // Specified root scope with /
            scope = this.rootScope;
          }
        }
        // TODO: Maybe deal with non-strings?
      }
      instructions = NavigationInstructionResolver.toViewportInstructions(this, instructions);
      for (const instruction of instructions as ViewportInstruction[]) {
        if (instruction.scope === null) {
          instruction.scope = scope;
        }
      }
    } else {
      instructions = NavigationInstructionResolver.toViewportInstructions(this, instructions);
    }

    if (options.append) {
      if (this.processingNavigation) {
        this.addedViewports.push(...(instructions as ViewportInstruction[]));
        // Can't return current navigation promise since it can lead to deadlock in enter
        return Promise.resolve();
      } else {
        // Can only append after first load has happened (defaults can fire too early)
        if (!this.loadedFirst) {
          return Promise.resolve();
        }
      }
    }

    const entry: INavigatorEntry = {
      instruction: instructions as ViewportInstruction[],
      fullStateInstruction: '',
      title: options.title,
      data: options.data,
      query: options.query,
      replacing: options.replace,
      repeating: options.append,
      fromBrowser: false,
    };
    return this.navigator.navigate(entry);
  }

  public refresh(): Promise<void> {
    return this.navigator.refresh();
  }

  public back(): Promise<void> {
    return this.navigator.go(-1);
  }

  public forward(): Promise<void> {
    return this.navigator.go(1);
  }

  public setNav(name: string, routes: INavRoute[], classes?: INavClasses): void {
    const nav = this.findNav(name);
    if (nav) {
      nav.routes = [];
    }
    this.addNav(name, routes, classes);
  }
  public addNav(name: string, routes: INavRoute[], classes?: INavClasses): void {
    let nav = this.navs[name];
    if (!nav) {
      nav = this.navs[name] = new Nav(this, name, [], classes);
    }
    nav.addRoutes(routes);
    nav.update();
  }
  public updateNav(name?: string): void {
    const navs = name
      ? [name]
      : Object.keys(this.navs);
    for (const nav of navs) {
      if (this.navs[nav]) {
        this.navs[nav].update();
      }
    }
  }
  public findNav(name: string): Nav {
    return this.navs[name];
  }

  /**
   * Finds the closest ancestor viewport.
   *
   * @param element The element to search upward from. The element is not searched.
   * @returns The Viewport that is the closest ancestor.
   */
  public closestViewport(element: Element): Viewport | null {
    let el: Element & { $viewport?: Viewport } | null = element;
    let $viewport: Viewport | undefined = el.$viewport;
    while (!$viewport && el.parentElement) {
      el = el.parentElement;
      $viewport = el.$viewport;
    }
    // TODO: Always also check controllers and return the closest one
    if (el.$viewport) {
      return el.$viewport;
    }
    el = element;
    let controller = CustomElement.behaviorFor(el);
    while (!controller && el.parentElement) {
      el = el.parentElement;
      CustomElement.behaviorFor(el);
    }
    while (controller) {
      if (controller.host) {
        const viewport = this.allViewports().find((item) => item.element === controller!.host);
        if (viewport) {
          return viewport;
        }
      }
      controller = controller.parent;
    }
    return null;
  }

  private findViewports(instructions: ViewportInstruction[], alreadyFound: ViewportInstruction[], withoutViewports: boolean = false): { found: ViewportInstruction[]; remaining: ViewportInstruction[] } {
    const found: ViewportInstruction[] = [];
    const remaining: ViewportInstruction[] = [];

    while (instructions.length) {
      const scope: Scope = instructions[0].scope!;
      const { foundViewports, remainingInstructions } = scope.findViewports(instructions.filter(instruction => instruction.scope === scope), alreadyFound, withoutViewports);
      found.push(...foundViewports);
      remaining.push(...remainingInstructions);
      instructions = instructions.filter(instruction => instruction.scope !== scope);
    }
    return { found, remaining };
  }

  private async cancelNavigation(updatedViewports: Viewport[], qInstruction: QueueItem<INavigatorInstruction>): Promise<void> {
    // TODO: Take care of disabling viewports when cancelling and stateful!
    updatedViewports.forEach((viewport) => {
      viewport.abortContentChange().catch(error => { throw error; });
    });
    await this.navigator.cancel(qInstruction as INavigatorInstruction);
    this.processingNavigation = null;
    (qInstruction.resolve as ((value: void | PromiseLike<void>) => void))();
  }

  private ensureRootScope(): void {
    if (!this.rootScope) {
      const root = this.container.get(Aurelia).root;
      this.rootScope = new Scope(this, root.host as Element, (root.controller as IController).context as IRenderContext, null);
      this.scopes.push(this.rootScope as Scope);
    }
  }

  private closestScope(element: Element): Scope {
    const viewport = this.closestViewport(element);
    if (viewport && (viewport.scope || viewport.owningScope)) {
      return viewport.scope || viewport.owningScope;
    }
    return this.rootScope!;
  }

  private replacePaths(instruction: INavigatorInstruction): Promise<void> {
    (this.rootScope as Scope).reparentViewportInstructions();
    const viewports: Viewport[] = (this.rootScope as Scope).viewports.filter((viewport) => viewport.enabled && !viewport.content.content.isEmpty());
    let instructions = viewports.map(viewport => viewport.content.content);
    // TODO: Check if this is really necessary
    instructions = this.instructionResolver.cloneViewportInstructions(instructions);

    for (const vpInstruction of instructions) {
      vpInstruction.scope = this.rootScope;
    }
    const alreadyFound: ViewportInstruction[] = [];
    let { found, remaining } = this.findViewports(instructions, alreadyFound, true);
    let guard = 100;
    while (remaining.length) {
      // Guard against endless loop
      if (!guard--) {
        throw new Error('Failed to find viewport when updating viewer paths.');
      }
      alreadyFound.push(...found);
      ({ found, remaining } = this.findViewports(remaining, alreadyFound, true));
    }

    this.activeComponents = instructions;

    let state = this.instructionResolver.stringifyViewportInstructions(instructions, false, true);

    if (this.options.transformToUrl) {
      // TODO: Review this. Also, should it perhaps get full state?
      const routeOrInstructions = this.options.transformToUrl(this.instructionResolver.parseViewportInstructions(state), this);
      state = Array.isArray(routeOrInstructions) ? this.instructionResolver.stringifyViewportInstructions(routeOrInstructions) : routeOrInstructions;
    }

    const query = (instruction.query && instruction.query.length ? `?${instruction.query}` : '');
    instruction.path = state + query;

    const fullViewportStates = [new ViewportInstruction(this.instructionResolver.clearViewportInstruction)];
    fullViewportStates.push(...this.instructionResolver.cloneViewportInstructions(instructions, this.options.statefulHistory));
    instruction.fullStateInstruction = fullViewportStates;
    return Promise.resolve();
  }
}

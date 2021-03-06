import { BasicConfiguration } from '@aurelia/jit-html-browser';
import { Aurelia } from '@aurelia/runtime';
import { App } from './app';

global['Aurelia'] = new Aurelia()
  .register(BasicConfiguration)
  .app({
    host: document.querySelector('app'),
    component: App
  })
  .start();

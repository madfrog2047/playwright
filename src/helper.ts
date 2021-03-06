/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { TimeoutError } from './errors';
import * as platform from './platform';

export const debugError = platform.debug(`pw:error`);

export type RegisteredListener = {
  emitter: platform.EventEmitterType;
  eventName: (string | symbol);
  handler: (...args: any[]) => void;
};

class Helper {
  static evaluationString(fun: Function | string, ...args: any[]): string {
    if (Helper.isString(fun)) {
      assert(args.length === 0, 'Cannot evaluate a string with arguments');
      return fun as string;
    }
    return `(${fun})(${args.map(serializeArgument).join(',')})`;

    function serializeArgument(arg: any): string {
      if (Object.is(arg, undefined))
        return 'undefined';
      return JSON.stringify(arg);
    }
  }

  static installApiHooks(className: string, classType: any) {
    const log = platform.debug('pw:api');
    for (const methodName of Reflect.ownKeys(classType.prototype)) {
      const method = Reflect.get(classType.prototype, methodName);
      if (methodName === 'constructor' || typeof methodName !== 'string' || methodName.startsWith('_') || typeof method !== 'function')
        continue;
      const isAsync = method.constructor.name === 'AsyncFunction';
      if (!isAsync && !log.enabled)
        continue;
      Reflect.set(classType.prototype, methodName, function(this: any, ...args: any[]) {
        if (log.enabled) {
          if (args.length)
            log(`${className}.${methodName} %o`, args);
          else
            log(`${className}.${methodName}`);
        }
        if (!isAsync)
          return method.call(this, ...args);
        const syncStack: any = {};
        Error.captureStackTrace(syncStack);
        return method.call(this, ...args).catch((e: any) => {
          const stack = syncStack.stack.substring(syncStack.stack.indexOf('\n') + 1);
          const clientStack = stack.substring(stack.indexOf('\n'));
          if (e instanceof Error && e.stack && !e.stack.includes(clientStack))
            e.stack += '\n  -- ASYNC --\n' + stack;
          throw e;
        });
      });
    }
  }

  static addEventListener(
    emitter: platform.EventEmitterType,
    eventName: (string | symbol),
    handler: (...args: any[]) => void): RegisteredListener {
    emitter.on(eventName, handler);
    return { emitter, eventName, handler };
  }

  static removeEventListeners(listeners: Array<{
      emitter: platform.EventEmitterType;
      eventName: (string | symbol);
      handler: (...args: any[]) => void;
    }>) {
    for (const listener of listeners)
      listener.emitter.removeListener(listener.eventName, listener.handler);
    listeners.splice(0, listeners.length);
  }

  static isString(obj: any): obj is string {
    return typeof obj === 'string' || obj instanceof String;
  }

  static isNumber(obj: any): obj is number {
    return typeof obj === 'number' || obj instanceof Number;
  }

  static async waitForEvent(
    emitter: platform.EventEmitterType,
    eventName: (string | symbol),
    predicate: Function,
    timeout: number,
    abortPromise: Promise<Error>): Promise<any> {
    let eventTimeout: NodeJS.Timer;
    let resolveCallback: (event: any) => void = () => {};
    let rejectCallback: (error: any) => void = () => {};
    const promise = new Promise((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    const listener = Helper.addEventListener(emitter, eventName, event => {
      try {
        if (!predicate(event))
          return;
        resolveCallback(event);
      } catch (e) {
        rejectCallback(e);
      }
    });
    if (timeout) {
      eventTimeout = setTimeout(() => {
        rejectCallback(new TimeoutError(`Timeout exceeded while waiting for ${String(eventName)}`));
      }, timeout);
    }
    function cleanup() {
      Helper.removeEventListeners([listener]);
      clearTimeout(eventTimeout);
    }
    const result = await Promise.race([promise, abortPromise]).then(r => {
      cleanup();
      return r;
    }, e => {
      cleanup();
      throw e;
    });
    if (result instanceof Error)
      throw result;
    return result;
  }

  static async waitWithTimeout<T>(promise: Promise<T>, taskName: string, timeout: number): Promise<T> {
    let reject: (error: Error) => void;
    const timeoutError = new TimeoutError(`waiting for ${taskName} failed: timeout ${timeout}ms exceeded`);
    const timeoutPromise = new Promise<T>((resolve, x) => reject = x);
    let timeoutTimer = null;
    if (timeout)
      timeoutTimer = setTimeout(() => reject(timeoutError), timeout);
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutTimer)
        clearTimeout(timeoutTimer);
    }
  }
}

export function assert(value: any, message?: string) {
  if (!value)
    throw new Error(message);
}

export const helper = Helper;

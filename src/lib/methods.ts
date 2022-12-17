/**
 * Methods and Tools
 * @desc    Methods and Tools
 * @author  Acgua <https://github.com/Acgua/ioBroker.roborock>
 * @license Apache License 2.0
 *
 * ----------------------------------------------------------------------------------------
 * How to implement this file in main.ts (see also https://stackoverflow.com/a/58459668)
 * ----------------------------------------------------------------------------------------
 *  1. Add "this: Roborock" as first function parameter if you need access to "this"
 *       -> no need to provide this parameter when calling the method, though!
 *  1. Add line like "import { err2Str, wait } from './lib/methods';"
 *  2. Add keyword "export" before "class Roborock extends utils.Adapter"
 *  3. class Roborock: for each method, add line like: "public wait = wait.bind(this);"
 *           Note: use "private wait..." and not "public", if you do not need to access method from this file
 */

import { Roborock } from '../main';

/**
 * Convert error to string
 * @param {*} error - any kind of thrown error
 * @returns string
 */
export function err2Str(error: any): string {
    if (error instanceof Error) {
        if (error.stack) return error.stack;
        if (error.message) return error.message;
        return JSON.stringify(error);
    } else {
        if (typeof error === 'string') return error;
        return JSON.stringify(error);
    }
}

/**
 * async wait/pause
 * Actually not needed since a single line, but for the sake of using wait more easily
 * @param {number} ms - number of milliseconds to wait
 */
export async function wait(this: Roborock, ms: number): Promise<void> {
    try {
        await new Promise((w) => setTimeout(w, ms));
    } catch (e) {
        this.log.error(this.err2Str(e));
        return;
    }
}

/**
 * Checks if an operand (variable, constant, object, ...) is considered as empty.
 * - empty:     undefined; null; string|array|object, stringified and only with white space(s), and/or `><[]{}`
 * - NOT empty: not matching anything above; any function; boolean false; number -1
 * inspired by helper.js from SmartControl adapter
 */
export function isEmpty(toCheck: any): true | false {
    if (toCheck === null || typeof toCheck === 'undefined') return true;
    if (typeof toCheck === 'function') return false;
    let x = JSON.stringify(toCheck);
    x = x.replace(/\s+/g, ''); // white space(s)
    x = x.replace(/"+/g, ''); // "
    x = x.replace(/'+/g, ''); // '
    x = x.replace(/\[+/g, ''); // [
    x = x.replace(/\]+/g, ''); // ]
    x = x.replace(/\{+/g, ''); // {
    x = x.replace(/\}+/g, ''); // }
    return x === '' ? true : false;
}

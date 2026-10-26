/// <reference lib="dom" />
/* global window, location, XMLHttpRequest, HTMLScriptElement, HTMLIFrameElement, Document, document */
'use strict';

(() => {
    const hosts = [
        'www.accounts.home.id',
        'cdc.accounts.home.id',
        'cdns.gigya.com',
        'accounts.eu1.gigya.com',
        'cdns.eu1.gigya.com',
        'socialize.eu1.gigya.com',
    ];
    /**
     * @param {string} value SDK navigation or request URL.
     * @returns {string} Same-origin proxy URL where supported.
     */
    const local = value => {
        if (typeof value !== 'string') {
            return value;
        }
        if (value.startsWith('com.philips.air://loginredirect?')) {
            return `${location.origin}/_complete?${value.split('?').slice(1).join('?')}`;
        }
        for (const host of hosts) {
            if (value.startsWith(`https://${host}/`)) {
                return `${location.origin}${host === hosts[0] ? '' : `/_upstream/${host}`}${value.slice(host.length + 8)}`;
            }
        }
        try {
            const url = new URL(value);
            if (['https:', 'http:'].includes(url.protocol) && url.hostname === location.hostname) {
                if (url.pathname.startsWith('/js/')) {
                    return `${location.origin}/_upstream/cdns.gigya.com${url.pathname}${url.search}${url.hash}`;
                }
                return `${location.origin}${url.pathname}${url.search}${url.hash}`;
            }
        } catch {
            // Relative SDK URLs already resolve against this HTTPS origin.
        }
        return value;
    };
    /** @type {Window & typeof globalThis & {__philipsCloudUrl?: typeof local}} */
    const scope = window;
    scope.__philipsCloudUrl = local;
    const originalFetch = window.fetch;
    window.fetch = (input, options) =>
        originalFetch.call(
            window,
            input instanceof Request ? new Request(local(input.url), input) : local(String(input)),
            options,
        );
    const originalPostMessage = window.postMessage;
    window.postMessage = function (...args) {
        if (typeof args[1] === 'string' && hosts.some(host => args[1] === `https://${host}`)) {
            args[1] = location.origin;
        }
        return Reflect.apply(originalPostMessage, this, args);
    };
    const create = document.createElement;
    document.createElement = function (...args) {
        const element = Reflect.apply(create, this, args);
        if (args[0].toLowerCase() === 'script') {
            element.async = false;
        }
        return element;
    };
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, async = true, user, password) {
        return originalOpen.call(this, method, local(String(url)), async, user, password);
    };
    for (const prototype of [HTMLScriptElement.prototype, HTMLIFrameElement.prototype]) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'src');
        if (descriptor?.get && descriptor.set) {
            const { get, set } = descriptor;
            Object.defineProperty(prototype, 'src', {
                get() {
                    return get.call(this);
                },
                set(value) {
                    set.call(this, local(value));
                },
            });
        }
    }
    // Cookies ignore ports; isolate provider sessions sharing the Admin hostname.
    const cookiePrefix = '__PHILIPS_COOKIE_PREFIX__';
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (cookie?.get && cookie.set) {
        const { get, set } = cookie;
        Object.defineProperty(document, 'cookie', {
            get: () =>
                get
                    .call(document)
                    .split(';')
                    .map(value => value.trim())
                    .filter(value => value.startsWith(cookiePrefix))
                    .map(value => value.slice(cookiePrefix.length))
                    .join('; '),
            set: value => {
                if (/^\s*__Host-philips-login-/i.test(value)) {
                    return;
                }
                set.call(document, cookiePrefix + value.trim().replace(/;\s*domain=[^;]+/gi, ''));
            },
        });
    }
})();

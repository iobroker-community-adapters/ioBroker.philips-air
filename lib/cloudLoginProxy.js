'use strict';

const https = require('node:https');
const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { CookieJar } = require('tough-cookie');
const { CloudError } = require('./cloudAccount');

const HOSTS = [
    'www.accounts.home.id',
    'cdc.accounts.home.id',
    'cdns.gigya.com',
    'accounts.eu1.gigya.com',
    'cdns.eu1.gigya.com',
    'socialize.eu1.gigya.com',
];
const REDIRECT = 'com.philips.air://loginredirect';
const MAX_BODY = 1024 * 1024;
const MAX_RESPONSE = 12 * 1024 * 1024;
const SHIM = readFileSync(join(__dirname, '../admin/cloud-login.js'), 'utf8');

/** Ephemeral, authenticated HTTPS bridge for the Home.ID browser login. */
class CloudLoginProxy {
    /**
     * @param {object} options Session dependencies.
     * @param {import('./cloudAccount').CloudAccount} options.account Shared account.
     * @param {string} options.owner Trusted Admin owner.
     * @param {string} options.hostname Admin browser hostname.
     * @param {string} options.returnUrl Admin settings URL.
     * @param {import('node:https').ServerOptions} options.certificates Admin TLS certificate.
     * @param {(callback: () => void, delay: number) => ReturnType<typeof setTimeout>} [options.setTimeout] Managed timer.
     * @param {(timer: ReturnType<typeof setTimeout>) => void} [options.clearTimeout] Managed timer cleanup.
     */
    constructor(options) {
        this.options = options;
        this.account = options.account;
        this.jar = new CookieJar();
        this.nonce = randomBytes(32).toString('hex');
        this.cookie = `__Host-philips-login-${randomBytes(12).toString('hex')}=${randomBytes(32).toString('hex')}`;
        this.cookiePrefix = `philips-${randomBytes(12).toString('hex')}-`;
        this.abort = new AbortController();
        this.completed = false;
        this.destroyed = false;
        this.active = 0;
        /** @type {number | undefined} */
        this.completingGeneration = undefined;
        this.origin = '';
        this.bootstrap = false;
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        this.timer = undefined;
        /** @type {import('node:https').Server | undefined} */
        this.server = undefined;
        /** @type {typeof this.account.login} */
        this.pending = undefined;
    }

    /** @returns {Promise<{url: string}>} One-use bootstrap link. */
    async start() {
        try {
            if (this.server || this.destroyed || !this.options.certificates?.key || !this.options.certificates?.cert) {
                throw new CloudError('login_proxy_unavailable');
            }
            const hostname = this.options.hostname;
            if (!hostname || /[\s/@?#\\]/.test(hostname)) {
                throw new CloudError('invalid_admin_origin');
            }
            const authorize = this.account.startLogin(this.options.owner).url;
            this.pending = this.account.login;
            this.server = https.createServer(this.options.certificates, (req, res) => {
                void this.handle(req, res, authorize).catch(() => {
                    if (!res.headersSent) {
                        res.writeHead(502, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' });
                    }
                    res.end('Home.ID login request failed. Start a new login in the instance settings.');
                });
            });
            this.server.requestTimeout = 30000;
            this.server.headersTimeout = 10000;
            this.server.maxHeadersCount = 100;
            const server = this.server;
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, () => resolve(undefined));
            });
            if (this.destroyed) {
                this.server.closeAllConnections();
                this.server.close();
                throw new CloudError('stopped');
            }
            const address = this.server.address();
            if (!address || typeof address === 'string') {
                throw new CloudError('login_proxy_unavailable');
            }
            this.origin = new URL(`https://${hostname}:${address.port}`).origin;
            this.timer = (this.options.setTimeout || setTimeout)(() => this.destroy(), 600000);
            return { url: `${this.origin}/_start?nonce=${this.nonce}` };
        } catch (error) {
            if (error instanceof CloudError) {
                throw error;
            }
            throw new CloudError('login_proxy_start_failed');
        }
    }

    /**
     * @param {string} host Allowed upstream hostname.
     * @returns {string} Local origin/path.
     */
    local(host) {
        return host === HOSTS[0] ? this.origin : `${this.origin}/_upstream/${host}`;
    }

    /**
     * @param {string} value Upstream document or URL.
     * @returns {string} Browser-local document or URL.
     */
    rewrite(value) {
        for (const host of HOSTS) {
            const boundary = '(?=[/\\\\?#"\'\\s<]|$)';
            const domain = host.replaceAll('.', '\\.');
            value = value.replace(new RegExp(`https://${domain}${boundary}`, 'g'), this.local(host));
            value = value.replace(
                new RegExp(`https:\\\\/\\\\/${domain}${boundary}`, 'g'),
                this.local(host).replaceAll('/', '\\/'),
            );
        }
        // shortcut: upstream SDK syntax is matched here; revisit if Home.ID changes its login scripts.
        // Retain Home.ID's identity for numeric IPs and private Admin hostnames.
        value = value.replace(
            /(\w+)&&(\w+)&&\2!==(\w+)\?""\.concat\(\1,"\."\)\.concat\(\2\)/g,
            '$1&&$2&&$2!==$3?"cdc.accounts.home.id"',
        );
        return value.replace(
            /\.location\(\)\.href=([a-zA-Z_$][\w$]*)/g,
            '.location().href=window.__philipsCloudUrl($1)',
        );
    }

    /**
     * @param {string} value Local URL or form value.
     * @returns {string} Original upstream value.
     */
    reverse(value) {
        for (const host of [...HOSTS].reverse()) {
            value = value.split(this.local(host)).join(`https://${host}`);
        }
        return value;
    }

    /**
     * @param {import('node:stream').Readable | ReadableStream<Uint8Array>} source Bounded payload stream.
     * @param {number} limit Maximum bytes.
     * @returns {Promise<Buffer>} Buffered payload.
     */
    async read(source, limit) {
        const chunks = [];
        let size = 0;
        for await (const chunk of source) {
            const data = Buffer.from(chunk);
            size += data.length;
            if (size > limit) {
                throw new CloudError('login_proxy_payload_too_large');
            }
            chunks.push(data);
        }
        return Buffer.concat(chunks);
    }

    /**
     * @param {import('node:http').IncomingMessage} req Browser request.
     * @param {import('node:http').ServerResponse} res Browser response.
     * @param {string} authorize OAuth authorization URL.
     * @returns {Promise<void>} Response completion.
     */
    async handle(req, res, authorize) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (
            this.destroyed ||
            req.headers.host !== new URL(this.origin).host ||
            !req.url?.startsWith('/') ||
            req.url.startsWith('//') ||
            req.url.length > 32768 ||
            !['GET', 'HEAD', 'POST'].includes(req.method || '') ||
            (req.method === 'POST' && req.headers.origin !== this.origin)
        ) {
            res.writeHead(403).end();
            return;
        }
        const url = new URL(req.url, this.origin);
        if (url.pathname === '/_start') {
            if (this.bootstrap || req.method !== 'GET' || url.searchParams.get('nonce') !== this.nonce) {
                res.writeHead(403).end();
                return;
            }
            this.bootstrap = true;
            this.nonce = '';
            res.setHeader('Set-Cookie', `${this.cookie}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
            res.writeHead(302, { Location: this.rewrite(authorize) }).end();
            return;
        }
        if (!(req.headers.cookie || '').split(';').some(cookie => cookie.trim() === this.cookie)) {
            res.writeHead(403).end();
            return;
        }
        if (url.pathname === '/_complete') {
            if (this.completed || this.account.login !== this.pending || req.method !== 'GET') {
                res.writeHead(403).end();
                return;
            }
            const generation = this.account.generation;
            const completion = this.account.completeLogin(`${REDIRECT}${url.search}`, this.options.owner);
            if (this.account.generation !== generation) {
                this.completingGeneration = this.account.generation;
            }
            await completion;
            if (this.destroyed) {
                throw new CloudError('stopped');
            }
            this.completed = true;
            const href = this.options.returnUrl.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.once('finish', () => this.destroy());
            res.end(
                `<html><head><title>Home.ID</title></head><body><h1>Signed in</h1><p>Close this tab and reload the instance settings.</p><a href="${href}">Return to ioBroker settings</a></body></html>`,
            );
            return;
        }
        if (this.active >= 12) {
            res.writeHead(429).end();
            return;
        }
        this.active++;
        try {
            await this.forward(req, res, url);
        } finally {
            this.active--;
        }
    }

    /**
     * @param {import('node:http').IncomingMessage} req Authenticated browser request.
     * @param {import('node:http').ServerResponse} res Browser response.
     * @param {URL} url Local request URL.
     * @returns {Promise<void>} Bounded upstream response.
     */
    async forward(req, res, url) {
        const match = url.pathname.match(/^\/_upstream\/([^/]+)(\/.*)?$/);
        if (url.pathname.startsWith('/_upstream') && (!match || !HOSTS.includes(match[1]))) {
            res.writeHead(403).end();
            return;
        }
        const host = match
            ? match[1]
            : /^\/(sdk\.|accounts\.|socialize\.|oidc\/)/.test(url.pathname)
              ? HOSTS[1]
              : HOSTS[0];
        const target = new URL(`https://${host}`);
        target.pathname = match ? match[2] || '/' : url.pathname;
        target.search = url.search;
        for (const [key, value] of target.searchParams) {
            target.searchParams.set(key, this.reverse(value));
        }
        /** @type {Record<string, string>} */
        const headers = {};
        for (const name of ['accept', 'accept-language', 'user-agent', 'content-type', 'x-requested-with']) {
            const value = req.headers[name];
            if (typeof value === 'string') {
                headers[name] = value;
            }
        }
        if (req.headers.origin) {
            headers.origin = 'https://www.accounts.home.id';
        }
        if (req.headers.referer?.startsWith(`${this.origin}/`)) {
            headers.referer = this.reverse(req.headers.referer);
        }
        headers.cookie = await this.jar.getCookieString(target.href);
        // Home.ID's SDK creates session cookies in document.cookie; never forward the proxy capability.
        if ([HOSTS[0], HOSTS[1]].includes(host)) {
            const browser = (req.headers.cookie || '')
                .split(';')
                .map(value => value.trim())
                .filter(value => value.startsWith(this.cookiePrefix))
                .map(value => value.slice(this.cookiePrefix.length))
                .filter(value => /^(?:gig_|glt_|gmid=|ucid=|hasGmid=|apiDomain_)/.test(value));
            headers.cookie = [headers.cookie, ...browser].filter(Boolean).join('; ');
        }
        let body;
        if (req.method === 'POST') {
            body = (await this.read(req, MAX_BODY)).toString();
            if (headers['content-type']?.includes('application/x-www-form-urlencoded')) {
                const params = new URLSearchParams(body);
                for (const [key, value] of params) {
                    params.set(key, this.reverse(value));
                }
                body = params.toString();
            } else {
                body = this.reverse(body);
            }
        }
        const response = await fetch(target, {
            method: req.method,
            headers,
            body,
            redirect: 'manual',
            signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(20000)]),
        });
        if (this.destroyed) {
            await response.body?.cancel();
            throw new CloudError('stopped');
        }
        const cookies = [];
        for (const value of response.headers.getSetCookie()) {
            const cookie = await this.jar.setCookie(value, target.href, { ignoreError: true });
            if (cookie && !cookie.httpOnly && !cookie.key.startsWith('__Host-philips-login-')) {
                cookies.push(`${this.cookiePrefix}${cookie.cookieString()}; Path=/; Secure; SameSite=Lax`);
            }
        }
        if (cookies.length) {
            res.setHeader('Set-Cookie', cookies);
        }
        const location = response.headers.get('location');
        if (location) {
            await response.body?.cancel();
            const redirect = new URL(location, target);
            let local;
            if (
                `${redirect.protocol}//${redirect.host}${redirect.pathname}` === REDIRECT &&
                !redirect.hash &&
                !redirect.username &&
                !redirect.password
            ) {
                local = `${this.origin}/_complete${redirect.search}`;
            } else if (
                redirect.protocol === 'https:' &&
                !redirect.username &&
                !redirect.password &&
                HOSTS.includes(redirect.host)
            ) {
                local = this.rewrite(redirect.href);
            } else {
                throw new CloudError('login_proxy_redirect_rejected');
            }
            res.writeHead(response.status, { Location: local }).end();
            return;
        }
        const type = response.headers.get('content-type') || 'application/octet-stream';
        let data = response.body ? await this.read(response.body, MAX_RESPONSE) : Buffer.alloc(0);
        if (/(?:text|javascript|json)/i.test(type)) {
            data = Buffer.from(this.rewrite(data.toString()));
        }
        if (type.includes('text/html')) {
            data = Buffer.from(
                data
                    .toString()
                    .replace(
                        /<head(?:\s[^>]*)?>/i,
                        head =>
                            `${head}<script>${SHIM.replace('__PHILIPS_COOKIE_PREFIX__', this.cookiePrefix)}</script>`,
                    ),
            );
        }
        res.writeHead(response.status, { 'Content-Type': type }).end(data);
    }

    /** Stop owned resources, preserving the shared account and later login attempts. */
    destroy() {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        if (this.timer) {
            (this.options.clearTimeout || clearTimeout)(this.timer);
        }
        if (this.account.login === this.pending) {
            this.account.login = undefined;
        }
        if (
            !this.completed &&
            this.completingGeneration !== undefined &&
            this.account.generation === this.completingGeneration
        ) {
            this.account.generation++;
            this.account.authorizing = false;
        }
        this.abort.abort();
        this.server?.close();
        this.server?.closeAllConnections();
        this.jar.removeAllCookiesSync();
        this.cookie = '';
        this.nonce = '';
    }
}

module.exports = CloudLoginProxy;

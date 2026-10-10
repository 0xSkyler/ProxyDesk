'use strict';
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function loadTree(root, electron, globals = {}) {
    const cache = new Map();
    function load(file) {
        if (!path.extname(file)) file = fs.existsSync(`${file}.js`) ? `${file}.js` : path.join(file, 'index.js');
        if (cache.has(file)) return cache.get(file).exports;
        if (path.basename(file) === 'Logger.js') return { logger: { info() {}, warn() {}, error() {}, close: async () => {} } };
        const module = { exports: {} }; cache.set(file, module);
        const context = vm.createContext({ console, process, URL, AbortController, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, ...globals });
        const fn = vm.runInContext(`(function(require,module,exports,__dirname){${fs.readFileSync(file, 'utf8')}\n})`, context, { filename: file });
        fn((name) => name === 'electron' ? electron : name.startsWith('.') ? load(path.resolve(path.dirname(file), name)) : require(name), module, module.exports, path.dirname(file));
        return module.exports;
    }
    return (relative) => load(path.join(root, relative));
}
function fakeElectron() {
    let nextId = 1;
    const app = new EventEmitter();
    app.getPath = () => path.join(require('node:os').tmpdir(), 'dom-test-no-legacy-partitions');
    const views = [];
    const sessions = new Map();
    class WebContents extends EventEmitter {
        id = nextId++;
        destroyed = false;
        url = 'about:blank';
        boundsWrites = 0;
        stop() { this.stopped = true; }
        close() { this.destroyed = true; this.removeAllListeners(); }
        isDestroyed() { return this.destroyed; }
        getURL() { return this.url; }
        async loadURL(url) { this.url = url; this.emit('dom-ready'); }
        canGoBack() { return false; }
        canGoForward() { return false; }
        setWindowOpenHandler(handler) { this.openHandler = handler; }
        reload() { this.reloaded = true; }
        executeJavaScript() { return Promise.resolve({}); }
    }
    class BrowserView {
        constructor(options) { this.options = options; this.webContents = new WebContents(); views.push(this); }
        setBounds(bounds) { this.bounds = bounds; this.webContents.boundsWrites++; }
    }
    const window = {
        isDestroyed: () => false,
        addBrowserView(view) { view.attached = true; },
        removeBrowserView(view) { view.attached = false; }
    };
    const session = { fromPartition(name) {
        if (!sessions.has(name)) sessions.set(name, {
            clearStorageData: async () => {}, clearCache: async () => {},
            setProxy: async function (proxy) { this.proxy = proxy; },
            closeAllConnections: async function () { this.connectionsClosed = (this.connectionsClosed || 0) + 1; }
        });
        return sessions.get(name);
    }};
    return { app, session, BrowserView, views, window, sessions };
}
module.exports = { loadTree, fakeElectron };

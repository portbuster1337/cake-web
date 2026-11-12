/* Wallet worker (classic worker).
 *
 * Runs the monero-ts wallet (Monero's wallet2 compiled to WebAssembly). Keys
 * never leave this worker except as the encrypted wallet files handed back to
 * the page for storage.
 *
 * The worker does no networking of its own: every HTTP request wallet2 makes
 * is forwarded over a MessagePort to the page's network router, which only
 * sends it out over Tor (or to a node the user explicitly approved on their
 * own machine / LAN).
 */
/* global importScripts */
importScripts('./vendor/monero.worker.js');

(function () {
  'use strict';
  var moneroOnMessage = self.onmessage;
  var port = null;
  var seq = 0;
  var pending = new Map();
  var queue = [];
  var decoder = new TextDecoder();

  function attach(p) {
    port = p;
    port.onmessage = function (ev) {
      var m = ev.data;
      var entry = pending.get(m.id);
      if (!entry) return;
      pending.delete(m.id);
      if (!m.ok) {
        entry.reject(new Error(m.error || 'network error'));
        return;
      }
      var body = new Uint8Array(m.body);
      entry.resolve({
        statusCode: m.status,
        statusText: m.statusText,
        headers: m.headers || {},
        body: entry.binary ? body : decoder.decode(body),
      });
    };
    while (queue.length) port.postMessage(queue.shift());
  }

  self.onmessage = function (e) {
    if (e.data && e.data.__cwNetPort) {
      attach(e.data.__cwNetPort);
      return;
    }
    return moneroOnMessage.call(self, e);
  };

  self.HttpClient.request = function (req) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var binary = req.body instanceof Uint8Array;
      pending.set(id, { resolve: resolve, reject: reject, binary: binary });
      if (req.cancelToken && req.cancelToken.promise) {
        req.cancelToken.promise.then(function () {
          if (!pending.has(id)) return;
          pending.delete(id);
          if (port) port.postMessage({ cancel: id });
          reject(new Error('Request cancelled'));
        });
      }
      var msg = {
        id: id,
        method: req.method,
        uri: req.uri,
        body: req.body,
        binary: binary,
        username: req.username || '',
        password: req.password || '',
      };
      if (port) port.postMessage(msg);
      else queue.push(msg);
    });
  };

  // Defense in depth: nothing in this worker may open its own connections.
  var realFetch = self.fetch && self.fetch.bind(self);
  self.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/^(data|blob):/i.test(url) || new URL(url, self.location.href).origin === self.location.origin) {
      return realFetch(input, init);
    }
    return Promise.reject(new Error('Blocked: the wallet worker may not make network requests'));
  };
  self.WebSocket = function () {
    throw new Error('Blocked: the wallet worker may not open sockets');
  };
  if (self.XMLHttpRequest) {
    var realOpen = self.XMLHttpRequest.prototype.open;
    self.XMLHttpRequest.prototype.open = function (method, url) {
      var u = new URL(String(url), self.location.href);
      if (u.protocol !== 'data:' && u.protocol !== 'blob:' && u.origin !== self.location.origin) {
        throw new Error('Blocked: the wallet worker may not make network requests');
      }
      return realOpen.apply(this, arguments);
    };
  }
})();

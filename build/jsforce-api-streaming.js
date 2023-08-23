(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g=(g.jsforce||(g.jsforce = {}));g=(g.modules||(g.modules = {}));g=(g.api||(g.api = {}));g.Streaming = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
/**
 * Faye Client extensions: https://faye.jcoglan.com/browser/extensions.html
 *
 * For use with Streaming.prototype.createClient()
**/
var StreamingExtension = {};

/**
 * Constructor for an auth failure detector extension
 *
 * Based on new feature released with Salesforce Spring '18:
 * https://releasenotes.docs.salesforce.com/en-us/spring18/release-notes/rn_messaging_cometd_auth_validation.htm?edition=&impact=
 *
 * Example triggering error message:
 *
 * ```
 * {
 *   "ext":{
 *     "sfdc":{"failureReason":"401::Authentication invalid"},
 *     "replay":true},
 *   "advice":{"reconnect":"none"},
 *   "channel":"/meta/handshake",
 *   "error":"403::Handshake denied",
 *   "successful":false
 * }
 * ```
 *
 * Example usage:
 *
 * ```javascript
 * const conn = new jsforce.Connection({ … });
 * 
 * const channel = "/event/My_Event__e";
 * 
 * // Exit the Node process when auth fails
 * const exitCallback = () => process.exit(1);
 * const authFailureExt = new jsforce.StreamingExtension.AuthFailure(exitCallback);
 * 
 * const fayeClient = conn.streaming.createClient([ authFailureExt ]);
 * 
 * const subscription = fayeClient.subscribe(channel, data => {
 *   console.log('topic received data', data);
 * });
 * 
 * subscription.cancel();
 * ```
 *
 * @param {Function} failureCallback - Invoked when authentication becomes invalid
 */
StreamingExtension.AuthFailure = function(failureCallback) {
  this.incoming = function(message, callback) {
    if (
      (message.channel === '/meta/connect' ||
        message.channel === '/meta/handshake')
      && message.advice
      && message.advice.reconnect == 'none'
    ) {
      failureCallback(message);
    } else {
      callback(message);
    }
  }
};

/**
 * Constructor for a durable streaming replay extension
 *
 * Modified from original Salesforce demo source code:
 * https://github.com/developerforce/SalesforceDurableStreamingDemo/blob/3d4a56eac956f744ad6c22e6a8141b6feb57abb9/staticresources/cometdReplayExtension.resource
 * 
 * Example usage:
 *
 * ```javascript
 * const conn = new jsforce.Connection({ … });
 * 
 * const channel = "/event/My_Event__e";
 * const replayId = -2; // -2 is all retained events
 * 
 * const replayExt = new jsforce.StreamingExtension.Replay(channel, replayId);
 * 
 * const fayeClient = conn.streaming.createClient([ replayExt ]);
 * 
 * const subscription = fayeClient.subscribe(channel, data => {
 *   console.log('topic received data', data);
 * });
 * 
 * subscription.cancel();
 * ```
 */
StreamingExtension.Replay = function(channel, replayId) {
  var REPLAY_FROM_KEY = "replay";
  
  var _extensionEnabled = replayId != null ? true : false;
  var _replay = replayId;
  var _channel = channel;

  this.setExtensionEnabled = function(extensionEnabled) {
    _extensionEnabled = extensionEnabled;
  }

  this.setReplay = function (replay) {
    _replay = parseInt(replay, 10);
  }

  this.setChannel = function(channel) {
    _channel = channel;
  }

  this.incoming = function(message, callback) {
    if (message.channel === '/meta/handshake') {
      if (message.ext && message.ext[REPLAY_FROM_KEY] == true) {
        _extensionEnabled = true;
      }
    } else if (message.channel === _channel && message.data && message.data.event && message.data.event.replayId) {
      _replay = message.data.event.replayId;
    }
    callback(message);
  }
  
  this.outgoing = function(message, callback) {
    if (message.channel === '/meta/subscribe' && message.subscription === _channel) {
      if (_extensionEnabled) {
        if (!message.ext) { message.ext = {}; }

        var replayFromMap = {};
        replayFromMap[_channel] = _replay;

        // add "ext : { "replay" : { CHANNEL : REPLAY_VALUE }}" to subscribe message
        message.ext[REPLAY_FROM_KEY] = replayFromMap;
      }
    }
    callback(message);
  };
};

module.exports = StreamingExtension;

},{}],2:[function(require,module,exports){
/**
 * @file Manages Streaming APIs
 * @author Shinichi Tomita <shinichi.tomita@gmail.com>
 */

'use strict';

var events = window.jsforce.require('events'),
    inherits = window.jsforce.require('inherits'),
    _ = window.jsforce.require('lodash/core'),
    Faye   = require('faye'),
    StreamingExtension = require('./streaming-extension'),
    jsforce = window.jsforce.require('./core');

/**
 * Streaming API topic class
 *
 * @class Streaming~Topic
 * @param {Streaming} steaming - Streaming API object
 * @param {String} name - Topic name
 */
var Topic = function(streaming, name) {
  this._streaming = streaming;
  this.name = name;
};

/**
 * @typedef {Object} Streaming~StreamingMessage
 * @prop {Object} event
 * @prop {Object} event.type - Event type
 * @prop {Record} sobject - Record information
 */
/**
 * Subscribe listener to topic
 *
 * @method Streaming~Topic#subscribe
 * @param {Callback.<Streaming~StreamingMesasge>} listener - Streaming message listener
 * @returns {Subscription} - Faye subscription object
 */
Topic.prototype.subscribe = function(listener) {
  return this._streaming.subscribe(this.name, listener);
};

/**
 * Unsubscribe listener from topic
 *
 * @method Streaming~Topic#unsubscribe
 * @param {Callback.<Streaming~StreamingMesasge>} listener - Streaming message listener
 * @returns {Streaming~Topic}
 */
Topic.prototype.unsubscribe = function(listener) {
  this._streaming.unsubscribe(this.name, listener);
  return this;
};

/*--------------------------------------------*/

/**
 * Streaming API Generic Streaming Channel
 *
 * @class Streaming~Channel
 * @param {Streaming} steaming - Streaming API object
 * @param {String} name - Channel name (starts with "/u/")
 */
var Channel = function(streaming, name) {
  this._streaming = streaming;
  this._name = name;
};

/**
 * Subscribe to channel
 *
 * @param {Callback.<Streaming~StreamingMessage>} listener - Streaming message listener
 * @returns {Subscription} - Faye subscription object
 */
Channel.prototype.subscribe = function(listener) {
  return this._streaming.subscribe(this._name, listener);
};

Channel.prototype.unsubscribe = function(listener) {
  this._streaming.unsubscribe(this._name, listener);
  return this;
};

Channel.prototype.push = function(events, callback) {
  var isArray = _.isArray(events);
  events = isArray ? events : [ events ];
  var conn = this._streaming._conn;
  if (!this._id) {
    this._id = conn.sobject('StreamingChannel').findOne({ Name: this._name }, 'Id')
      .then(function(rec) { return rec.Id });
  }
  return this._id.then(function(id) {
    var channelUrl = '/sobjects/StreamingChannel/' + id + '/push';
    return conn.requestPost(channelUrl, { pushEvents: events });
  }).then(function(rets) {
    return isArray ? rets : rets[0];
  }).thenCall(callback);
};

/*--------------------------------------------*/

/**
 * Streaming API class
 *
 * @class
 * @extends events.EventEmitter
 * @param {Connection} conn - Connection object
 */
var Streaming = function(conn) {
  this._conn = conn;
};

inherits(Streaming, events.EventEmitter);

/** @private **/
Streaming.prototype._createClient = function(forChannelName, extensions) {
  // forChannelName is advisory, for an API workaround. It does not restrict or select the channel.
  var needsReplayFix = typeof forChannelName === 'string' && forChannelName.indexOf('/u/') === 0;
  var endpointUrl = [
    this._conn.instanceUrl,
    // special endpoint "/cometd/replay/xx.x" is only available in 36.0.
    // See https://releasenotes.docs.salesforce.com/en-us/summer16/release-notes/rn_api_streaming_classic_replay.htm
    "cometd" + (needsReplayFix === true && this._conn.version === "36.0" ? "/replay" : ""),
    this._conn.version
  ].join('/');
  var fayeClient = new Faye.Client(endpointUrl, {});
  fayeClient.setHeader('Authorization', 'OAuth '+this._conn.accessToken);
  if (extensions instanceof Array) {
    extensions.forEach(function(extension) {
      fayeClient.addExtension(extension);
    });
  }
  if (fayeClient._dispatcher.getConnectionTypes().indexOf('callback-polling') === -1) {
    // prevent streaming API server error
    fayeClient._dispatcher.selectTransport('long-polling');
    fayeClient._dispatcher._transport.batching = false;
  }
  return fayeClient;
};

/** @private **/
Streaming.prototype._getFayeClient = function(channelName) {
  var isGeneric = channelName.indexOf('/u/') === 0;
  var clientType = isGeneric ? 'generic' : 'pushTopic';
  if (!this._fayeClients || !this._fayeClients[clientType]) {
    this._fayeClients = this._fayeClients || {};
    this._fayeClients[clientType] = this._createClient(channelName);
  }
  return this._fayeClients[clientType];
};


/**
 * Get named topic
 *
 * @param {String} name - Topic name
 * @returns {Streaming~Topic}
 */
Streaming.prototype.topic = function(name) {
  this._topics = this._topics || {};
  var topic = this._topics[name] =
    this._topics[name] || new Topic(this, name);
  return topic;
};

/**
 * Get Channel for Id
 * @param {String} channelId - Id of StreamingChannel object
 * @returns {Streaming~Channel}
 */
Streaming.prototype.channel = function(channelId) {
  return new Channel(this, channelId);
};

/**
 * Subscribe topic/channel
 *
 * @param {String} name - Topic name
 * @param {Callback.<Streaming~StreamingMessage>} listener - Streaming message listener
 * @returns {Subscription} - Faye subscription object
 */
Streaming.prototype.subscribe = function(name, listener) {
  var channelName = name.indexOf('/') === 0 ? name : '/topic/' + name;
  var fayeClient = this._getFayeClient(channelName);
  return fayeClient.subscribe(channelName, listener);
};

/**
 * Unsubscribe topic
 *
 * @param {String} name - Topic name
 * @param {Callback.<Streaming~StreamingMessage>} listener - Streaming message listener
 * @returns {Streaming}
 */
Streaming.prototype.unsubscribe = function(name, listener) {
  var channelName = name.indexOf('/') === 0 ? name : '/topic/' + name;
  var fayeClient = this._getFayeClient(channelName);
  fayeClient.unsubscribe(channelName, listener);
  return this;
};


/**
 * Create a Streaming client, optionally with extensions
 *
 * See Faye docs for implementation details: https://faye.jcoglan.com/browser/extensions.html
 *
 * Example usage:
 * 
 * ```javascript
 * // Establish a Salesforce connection. (Details elided)
 * const conn = new jsforce.Connection({ … });
 * 
 * const fayeClient = conn.streaming.createClient();
 * 
 * const subscription = fayeClient.subscribe(channel, data => {
 *   console.log('topic received data', data);
 * });
 * 
 * subscription.cancel();
 * ```
 * 
 * Example with extensions, using Replay & Auth Failure extensions in a server-side Node.js app:
 * 
 * ```javascript
 * // Establish a Salesforce connection. (Details elided)
 * const conn = new jsforce.Connection({ … });
 * 
 * const channel = "/event/My_Event__e";
 * const replayId = -2; // -2 is all retained events
 * 
 * const exitCallback = () => process.exit(1);
 * const authFailureExt = new jsforce.StreamingExtension.AuthFailure(exitCallback);
 * 
 * const replayExt = new jsforce.StreamingExtension.Replay(channel, replayId);
 * 
 * const fayeClient = conn.streaming.createClient([
 *   authFailureExt,
 *   replayExt
 * ]);
 * 
 * const subscription = fayeClient.subscribe(channel, data => {
 *   console.log('topic received data', data);
 * });
 * 
 * subscription.cancel();
 * ```
 * 
 * @param {Array} Extensions - Optional, extensions to apply to the Faye client
 * @returns {FayeClient} - Faye client object
 */
Streaming.prototype.createClient = function(extensions) {
  return this._createClient(null, extensions);
};

/*--------------------------------------------*/
/*
 * Register hook in connection instantiation for dynamically adding this API module features
 */
jsforce.on('connection:new', function(conn) {
  conn.streaming = new Streaming(conn);
});

/*
 * 
 */
jsforce.StreamingExtension = StreamingExtension;

module.exports = Streaming;

},{"./streaming-extension":1,"faye":5}],3:[function(require,module,exports){
"use strict";

// rawAsap provides everything we need except exception management.
var rawAsap = require("./raw");
// RawTasks are recycled to reduce GC churn.
var freeTasks = [];
// We queue errors to ensure they are thrown in right order (FIFO).
// Array-as-queue is good enough here, since we are just dealing with exceptions.
var pendingErrors = [];
var requestErrorThrow = rawAsap.makeRequestCallFromTimer(throwFirstError);

function throwFirstError() {
    if (pendingErrors.length) {
        throw pendingErrors.shift();
    }
}

/**
 * Calls a task as soon as possible after returning, in its own event, with priority
 * over other events like animation, reflow, and repaint. An error thrown from an
 * event will not interrupt, nor even substantially slow down the processing of
 * other events, but will be rather postponed to a lower priority event.
 * @param {{call}} task A callable object, typically a function that takes no
 * arguments.
 */
module.exports = asap;
function asap(task) {
    var rawTask;
    if (freeTasks.length) {
        rawTask = freeTasks.pop();
    } else {
        rawTask = new RawTask();
    }
    rawTask.task = task;
    rawAsap(rawTask);
}

// We wrap tasks with recyclable task objects.  A task object implements
// `call`, just like a function.
function RawTask() {
    this.task = null;
}

// The sole purpose of wrapping the task is to catch the exception and recycle
// the task object after its single use.
RawTask.prototype.call = function () {
    try {
        this.task.call();
    } catch (error) {
        if (asap.onerror) {
            // This hook exists purely for testing purposes.
            // Its name will be periodically randomized to break any code that
            // depends on its existence.
            asap.onerror(error);
        } else {
            // In a web browser, exceptions are not fatal. However, to avoid
            // slowing down the queue of pending tasks, we rethrow the error in a
            // lower priority turn.
            pendingErrors.push(error);
            requestErrorThrow();
        }
    } finally {
        this.task = null;
        freeTasks[freeTasks.length] = this;
    }
};

},{"./raw":4}],4:[function(require,module,exports){
(function (global){
"use strict";

// Use the fastest means possible to execute a task in its own turn, with
// priority over other events including IO, animation, reflow, and redraw
// events in browsers.
//
// An exception thrown by a task will permanently interrupt the processing of
// subsequent tasks. The higher level `asap` function ensures that if an
// exception is thrown by a task, that the task queue will continue flushing as
// soon as possible, but if you use `rawAsap` directly, you are responsible to
// either ensure that no exceptions are thrown from your task, or to manually
// call `rawAsap.requestFlush` if an exception is thrown.
module.exports = rawAsap;
function rawAsap(task) {
    if (!queue.length) {
        requestFlush();
        flushing = true;
    }
    // Equivalent to push, but avoids a function call.
    queue[queue.length] = task;
}

var queue = [];
// Once a flush has been requested, no further calls to `requestFlush` are
// necessary until the next `flush` completes.
var flushing = false;
// `requestFlush` is an implementation-specific method that attempts to kick
// off a `flush` event as quickly as possible. `flush` will attempt to exhaust
// the event queue before yielding to the browser's own event loop.
var requestFlush;
// The position of the next task to execute in the task queue. This is
// preserved between calls to `flush` so that it can be resumed if
// a task throws an exception.
var index = 0;
// If a task schedules additional tasks recursively, the task queue can grow
// unbounded. To prevent memory exhaustion, the task queue will periodically
// truncate already-completed tasks.
var capacity = 1024;

// The flush function processes all tasks that have been scheduled with
// `rawAsap` unless and until one of those tasks throws an exception.
// If a task throws an exception, `flush` ensures that its state will remain
// consistent and will resume where it left off when called again.
// However, `flush` does not make any arrangements to be called again if an
// exception is thrown.
function flush() {
    while (index < queue.length) {
        var currentIndex = index;
        // Advance the index before calling the task. This ensures that we will
        // begin flushing on the next task the task throws an error.
        index = index + 1;
        queue[currentIndex].call();
        // Prevent leaking memory for long chains of recursive calls to `asap`.
        // If we call `asap` within tasks scheduled by `asap`, the queue will
        // grow, but to avoid an O(n) walk for every task we execute, we don't
        // shift tasks off the queue after they have been executed.
        // Instead, we periodically shift 1024 tasks off the queue.
        if (index > capacity) {
            // Manually shift all values starting at the index back to the
            // beginning of the queue.
            for (var scan = 0, newLength = queue.length - index; scan < newLength; scan++) {
                queue[scan] = queue[scan + index];
            }
            queue.length -= index;
            index = 0;
        }
    }
    queue.length = 0;
    index = 0;
    flushing = false;
}

// `requestFlush` is implemented using a strategy based on data collected from
// every available SauceLabs Selenium web driver worker at time of writing.
// https://docs.google.com/spreadsheets/d/1mG-5UYGup5qxGdEMWkhP6BWCz053NUb2E1QoUTU16uA/edit#gid=783724593

// Safari 6 and 6.1 for desktop, iPad, and iPhone are the only browsers that
// have WebKitMutationObserver but not un-prefixed MutationObserver.
// Must use `global` or `self` instead of `window` to work in both frames and web
// workers. `global` is a provision of Browserify, Mr, Mrs, or Mop.

/* globals self */
var scope = typeof global !== "undefined" ? global : self;
var BrowserMutationObserver = scope.MutationObserver || scope.WebKitMutationObserver;

// MutationObservers are desirable because they have high priority and work
// reliably everywhere they are implemented.
// They are implemented in all modern browsers.
//
// - Android 4-4.3
// - Chrome 26-34
// - Firefox 14-29
// - Internet Explorer 11
// - iPad Safari 6-7.1
// - iPhone Safari 7-7.1
// - Safari 6-7
if (typeof BrowserMutationObserver === "function") {
    requestFlush = makeRequestCallFromMutationObserver(flush);

// MessageChannels are desirable because they give direct access to the HTML
// task queue, are implemented in Internet Explorer 10, Safari 5.0-1, and Opera
// 11-12, and in web workers in many engines.
// Although message channels yield to any queued rendering and IO tasks, they
// would be better than imposing the 4ms delay of timers.
// However, they do not work reliably in Internet Explorer or Safari.

// Internet Explorer 10 is the only browser that has setImmediate but does
// not have MutationObservers.
// Although setImmediate yields to the browser's renderer, it would be
// preferrable to falling back to setTimeout since it does not have
// the minimum 4ms penalty.
// Unfortunately there appears to be a bug in Internet Explorer 10 Mobile (and
// Desktop to a lesser extent) that renders both setImmediate and
// MessageChannel useless for the purposes of ASAP.
// https://github.com/kriskowal/q/issues/396

// Timers are implemented universally.
// We fall back to timers in workers in most engines, and in foreground
// contexts in the following browsers.
// However, note that even this simple case requires nuances to operate in a
// broad spectrum of browsers.
//
// - Firefox 3-13
// - Internet Explorer 6-9
// - iPad Safari 4.3
// - Lynx 2.8.7
} else {
    requestFlush = makeRequestCallFromTimer(flush);
}

// `requestFlush` requests that the high priority event queue be flushed as
// soon as possible.
// This is useful to prevent an error thrown in a task from stalling the event
// queue if the exception handled by Node.js’s
// `process.on("uncaughtException")` or by a domain.
rawAsap.requestFlush = requestFlush;

// To request a high priority event, we induce a mutation observer by toggling
// the text of a text node between "1" and "-1".
function makeRequestCallFromMutationObserver(callback) {
    var toggle = 1;
    var observer = new BrowserMutationObserver(callback);
    var node = document.createTextNode("");
    observer.observe(node, {characterData: true});
    return function requestCall() {
        toggle = -toggle;
        node.data = toggle;
    };
}

// The message channel technique was discovered by Malte Ubl and was the
// original foundation for this library.
// http://www.nonblocking.io/2011/06/windownexttick.html

// Safari 6.0.5 (at least) intermittently fails to create message ports on a
// page's first load. Thankfully, this version of Safari supports
// MutationObservers, so we don't need to fall back in that case.

// function makeRequestCallFromMessageChannel(callback) {
//     var channel = new MessageChannel();
//     channel.port1.onmessage = callback;
//     return function requestCall() {
//         channel.port2.postMessage(0);
//     };
// }

// For reasons explained above, we are also unable to use `setImmediate`
// under any circumstances.
// Even if we were, there is another bug in Internet Explorer 10.
// It is not sufficient to assign `setImmediate` to `requestFlush` because
// `setImmediate` must be called *by name* and therefore must be wrapped in a
// closure.
// Never forget.

// function makeRequestCallFromSetImmediate(callback) {
//     return function requestCall() {
//         setImmediate(callback);
//     };
// }

// Safari 6.0 has a problem where timers will get lost while the user is
// scrolling. This problem does not impact ASAP because Safari 6.0 supports
// mutation observers, so that implementation is used instead.
// However, if we ever elect to use timers in Safari, the prevalent work-around
// is to add a scroll event listener that calls for a flush.

// `setTimeout` does not call the passed callback if the delay is less than
// approximately 7 in web workers in Firefox 8 through 18, and sometimes not
// even then.

function makeRequestCallFromTimer(callback) {
    return function requestCall() {
        // We dispatch a timeout with a specified delay of 0 for engines that
        // can reliably accommodate that request. This will usually be snapped
        // to a 4 milisecond delay, but once we're flushing, there's no delay
        // between events.
        var timeoutHandle = setTimeout(handleTimer, 0);
        // However, since this timer gets frequently dropped in Firefox
        // workers, we enlist an interval handle that will try to fire
        // an event 20 times per second until it succeeds.
        var intervalHandle = setInterval(handleTimer, 50);

        function handleTimer() {
            // Whichever timer succeeds will cancel both timers and
            // execute the callback.
            clearTimeout(timeoutHandle);
            clearInterval(intervalHandle);
            callback();
        }
    };
}

// This is for `asap.js` only.
// Its name will be periodically randomized to break any code that depends on
// its existence.
rawAsap.makeRequestCallFromTimer = makeRequestCallFromTimer;

// ASAP was originally a nextTick shim included in Q. This was factored out
// into this ASAP package. It was later adapted to RSVP which made further
// amendments. These decisions, particularly to marginalize MessageChannel and
// to capture the MutationObserver implementation in a closure, were integrated
// back into ASAP proper.
// https://github.com/tildeio/rsvp.js/blob/cddf7232546a9cf858524b75cde6f9edf72620a7/lib/rsvp/asap.js

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],5:[function(require,module,exports){
'use strict';

var constants = require('./util/constants'),
    Logging   = require('./mixins/logging');

var Faye = {
  VERSION:    constants.VERSION,

  Client:     require('./protocol/client'),
  Scheduler:  require('./protocol/scheduler')
};

Logging.wrapper = Faye;

module.exports = Faye;

},{"./mixins/logging":7,"./protocol/client":11,"./protocol/scheduler":17,"./util/constants":30}],6:[function(require,module,exports){
(function (global){
'use strict';

var Promise   = require('../util/promise');

module.exports = {
  then: function(callback, errback) {
    var self = this;
    if (!this._promise)
      this._promise = new Promise(function(resolve, reject) {
        self._resolve = resolve;
        self._reject  = reject;
      });

    if (arguments.length === 0)
      return this._promise;
    else
      return this._promise.then(callback, errback);
  },

  callback: function(callback, context) {
    return this.then(function(value) { callback.call(context, value) });
  },

  errback: function(callback, context) {
    return this.then(null, function(reason) { callback.call(context, reason) });
  },

  timeout: function(seconds, message) {
    this.then();
    var self = this;
    this._timer = global.setTimeout(function() {
      self._reject(message);
    }, seconds * 1000);
  },

  setDeferredStatus: function(status, value) {
    if (this._timer) global.clearTimeout(this._timer);

    this.then();

    if (status === 'succeeded')
      this._resolve(value);
    else if (status === 'failed')
      this._reject(value);
    else
      delete this._promise;
  }
};

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"../util/promise":34}],7:[function(require,module,exports){
'use strict';

var toJSON = require('../util/to_json');

var Logging = {
  LOG_LEVELS: {
    fatal:  4,
    error:  3,
    warn:   2,
    info:   1,
    debug:  0
  },

  writeLog: function(messageArgs, level) {
    var logger = Logging.logger || (Logging.wrapper || Logging).logger;
    if (!logger) return;

    var args   = Array.prototype.slice.apply(messageArgs),
        banner = '[Faye',
        klass  = this.className,

        message = args.shift().replace(/\?/g, function() {
          try {
            return toJSON(args.shift());
          } catch (error) {
            return '[Object]';
          }
        });

    if (klass) banner += '.' + klass;
    banner += '] ';

    if (typeof logger[level] === 'function')
      logger[level](banner + message);
    else if (typeof logger === 'function')
      logger(banner + message);
  }
};

for (var key in Logging.LOG_LEVELS)
  (function(level) {
    Logging[level] = function() {
      this.writeLog(arguments, level);
    };
  })(key);

module.exports = Logging;

},{"../util/to_json":36}],8:[function(require,module,exports){
'use strict';

var assign       = require('../util/assign'),
    EventEmitter = require('../util/event_emitter');

var Publisher = {
  countListeners: function(eventType) {
    return this.listeners(eventType).length;
  },

  bind: function(eventType, listener, context) {
    var slice   = Array.prototype.slice,
        handler = function() { listener.apply(context, slice.call(arguments)) };

    this._listeners = this._listeners || [];
    this._listeners.push([eventType, listener, context, handler]);
    return this.on(eventType, handler);
  },

  unbind: function(eventType, listener, context) {
    this._listeners = this._listeners || [];
    var n = this._listeners.length, tuple;

    while (n--) {
      tuple = this._listeners[n];
      if (tuple[0] !== eventType) continue;
      if (listener && (tuple[1] !== listener || tuple[2] !== context)) continue;
      this._listeners.splice(n, 1);
      this.removeListener(eventType, tuple[3]);
    }
  }
};

assign(Publisher, EventEmitter.prototype);
Publisher.trigger = Publisher.emit;

module.exports = Publisher;

},{"../util/assign":27,"../util/event_emitter":33}],9:[function(require,module,exports){
(function (global){
'use strict';

module.exports = {
  addTimeout: function(name, delay, callback, context) {
    this._timeouts = this._timeouts || {};
    if (this._timeouts.hasOwnProperty(name)) return;
    var self = this;
    this._timeouts[name] = global.setTimeout(function() {
      delete self._timeouts[name];
      callback.call(context);
    }, 1000 * delay);
  },

  removeTimeout: function(name) {
    this._timeouts = this._timeouts || {};
    var timeout = this._timeouts[name];
    if (!timeout) return;
    global.clearTimeout(timeout);
    delete this._timeouts[name];
  },

  removeAllTimeouts: function() {
    this._timeouts = this._timeouts || {};
    for (var name in this._timeouts) this.removeTimeout(name);
  }
};

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],10:[function(require,module,exports){
'use strict';

var Class     = require('../util/class'),
    assign    = require('../util/assign'),
    Publisher = require('../mixins/publisher'),
    Grammar   = require('./grammar');

var Channel = Class({
  initialize: function(name) {
    this.id = this.name = name;
  },

  push: function(message) {
    this.trigger('message', message);
  },

  isUnused: function() {
    return this.countListeners('message') === 0;
  }
});

assign(Channel.prototype, Publisher);

assign(Channel, {
  HANDSHAKE:    '/meta/handshake',
  CONNECT:      '/meta/connect',
  SUBSCRIBE:    '/meta/subscribe',
  UNSUBSCRIBE:  '/meta/unsubscribe',
  DISCONNECT:   '/meta/disconnect',

  META:         'meta',
  SERVICE:      'service',

  expand: function(name) {
    var segments = this.parse(name),
        channels = ['/**', name];

    var copy = segments.slice();
    copy[copy.length - 1] = '*';
    channels.push(this.unparse(copy));

    for (var i = 1, n = segments.length; i < n; i++) {
      copy = segments.slice(0, i);
      copy.push('**');
      channels.push(this.unparse(copy));
    }

    return channels;
  },

  isValid: function(name) {
    return Grammar.CHANNEL_NAME.test(name) ||
           Grammar.CHANNEL_PATTERN.test(name);
  },

  parse: function(name) {
    if (!this.isValid(name)) return null;
    return name.split('/').slice(1);
  },

  unparse: function(segments) {
    return '/' + segments.join('/');
  },

  isMeta: function(name) {
    var segments = this.parse(name);
    return segments ? (segments[0] === this.META) : null;
  },

  isService: function(name) {
    var segments = this.parse(name);
    return segments ? (segments[0] === this.SERVICE) : null;
  },

  isSubscribable: function(name) {
    if (!this.isValid(name)) return null;
    return !this.isMeta(name) && !this.isService(name);
  },

  Set: Class({
    initialize: function() {
      this._channels = {};
    },

    getKeys: function() {
      var keys = [];
      for (var key in this._channels) keys.push(key);
      return keys;
    },

    remove: function(name) {
      delete this._channels[name];
    },

    hasSubscription: function(name) {
      return this._channels.hasOwnProperty(name);
    },

    subscribe: function(names, subscription) {
      var name;
      for (var i = 0, n = names.length; i < n; i++) {
        name = names[i];
        var channel = this._channels[name] = this._channels[name] || new Channel(name);
        channel.bind('message', subscription);
      }
    },

    unsubscribe: function(name, subscription) {
      var channel = this._channels[name];
      if (!channel) return false;
      channel.unbind('message', subscription);

      if (channel.isUnused()) {
        this.remove(name);
        return true;
      } else {
        return false;
      }
    },

    distributeMessage: function(message) {
      var channels = Channel.expand(message.channel);

      for (var i = 0, n = channels.length; i < n; i++) {
        var channel = this._channels[channels[i]];
        if (channel) channel.trigger('message', message);
      }
    }
  })
});

module.exports = Channel;

},{"../mixins/publisher":8,"../util/assign":27,"../util/class":29,"./grammar":15}],11:[function(require,module,exports){
(function (global){
'use strict';

var asap            = require('asap'),
    Class           = require('../util/class'),
    Promise         = require('../util/promise'),
    array           = require('../util/array'),
    browser         = require('../util/browser'),
    constants       = require('../util/constants'),
    assign          = require('../util/assign'),
    validateOptions = require('../util/validate_options'),
    Deferrable      = require('../mixins/deferrable'),
    Logging         = require('../mixins/logging'),
    Publisher       = require('../mixins/publisher'),
    Channel         = require('./channel'),
    Dispatcher      = require('./dispatcher'),
    Error           = require('./error'),
    Extensible      = require('./extensible'),
    Publication     = require('./publication'),
    Subscription    = require('./subscription');

var Client = Class({ className: 'Client',
  UNCONNECTED:  1,
  CONNECTING:   2,
  CONNECTED:    3,
  DISCONNECTED: 4,

  HANDSHAKE: 'handshake',
  RETRY:     'retry',
  NONE:      'none',

  CONNECTION_TIMEOUT: 60,

  DEFAULT_ENDPOINT: '/bayeux',
  INTERVAL:         0,

  initialize: function(endpoint, options) {
    this.info('New client created for ?', endpoint);
    options = options || {};

    validateOptions(options, ['interval', 'timeout', 'endpoints', 'proxy', 'retry', 'scheduler', 'websocketExtensions', 'tls', 'ca']);

    this._channels   = new Channel.Set();
    this._dispatcher = Dispatcher.create(this, endpoint || this.DEFAULT_ENDPOINT, options);

    this._messageId = 0;
    this._state     = this.UNCONNECTED;

    this._responseCallbacks = {};

    this._advice = {
      reconnect: this.RETRY,
      interval:  1000 * (options.interval || this.INTERVAL),
      timeout:   1000 * (options.timeout  || this.CONNECTION_TIMEOUT)
    };
    this._dispatcher.timeout = this._advice.timeout / 1000;

    this._dispatcher.bind('message', this._receiveMessage, this);

    if (browser.Event && global.onbeforeunload !== undefined)
      browser.Event.on(global, 'beforeunload', function() {
        if (array.indexOf(this._dispatcher._disabled, 'autodisconnect') < 0)
          this.disconnect();
      }, this);
  },

  addWebsocketExtension: function(extension) {
    return this._dispatcher.addWebsocketExtension(extension);
  },

  disable: function(feature) {
    return this._dispatcher.disable(feature);
  },

  setHeader: function(name, value) {
    return this._dispatcher.setHeader(name, value);
  },

  // Request
  // MUST include:  * channel
  //                * version
  //                * supportedConnectionTypes
  // MAY include:   * minimumVersion
  //                * ext
  //                * id
  //
  // Success Response                             Failed Response
  // MUST include:  * channel                     MUST include:  * channel
  //                * version                                    * successful
  //                * supportedConnectionTypes                   * error
  //                * clientId                    MAY include:   * supportedConnectionTypes
  //                * successful                                 * advice
  // MAY include:   * minimumVersion                             * version
  //                * advice                                     * minimumVersion
  //                * ext                                        * ext
  //                * id                                         * id
  //                * authSuccessful
  handshake: function(callback, context) {
    if (this._advice.reconnect === this.NONE) return;
    if (this._state !== this.UNCONNECTED) return;

    this._state = this.CONNECTING;
    var self = this;

    this.info('Initiating handshake with ?', this._dispatcher.endpoint.href);
    this._dispatcher.selectTransport(constants.MANDATORY_CONNECTION_TYPES);

    this._sendMessage({
      channel:                  Channel.HANDSHAKE,
      version:                  constants.BAYEUX_VERSION,
      supportedConnectionTypes: this._dispatcher.getConnectionTypes()

    }, {}, function(response) {

      if (response.successful) {
        this._state = this.CONNECTED;
        this._dispatcher.clientId  = response.clientId;

        this._dispatcher.selectTransport(response.supportedConnectionTypes);

        this.info('Handshake successful: ?', this._dispatcher.clientId);

        this.subscribe(this._channels.getKeys(), true);
        if (callback) asap(function() { callback.call(context) });

      } else {
        this.info('Handshake unsuccessful');
        global.setTimeout(function() { self.handshake(callback, context) }, this._dispatcher.retry * 1000);
        this._state = this.UNCONNECTED;
      }
    }, this);
  },

  // Request                              Response
  // MUST include:  * channel             MUST include:  * channel
  //                * clientId                           * successful
  //                * connectionType                     * clientId
  // MAY include:   * ext                 MAY include:   * error
  //                * id                                 * advice
  //                                                     * ext
  //                                                     * id
  //                                                     * timestamp
  connect: function(callback, context) {
    if (this._advice.reconnect === this.NONE) return;
    if (this._state === this.DISCONNECTED) return;

    if (this._state === this.UNCONNECTED)
      return this.handshake(function() { this.connect(callback, context) }, this);

    this.callback(callback, context);
    if (this._state !== this.CONNECTED) return;

    this.info('Calling deferred actions for ?', this._dispatcher.clientId);
    this.setDeferredStatus('succeeded');
    this.setDeferredStatus('unknown');

    if (this._connectRequest) return;
    this._connectRequest = true;

    this.info('Initiating connection for ?', this._dispatcher.clientId);

    this._sendMessage({
      channel:        Channel.CONNECT,
      clientId:       this._dispatcher.clientId,
      connectionType: this._dispatcher.connectionType

    }, {}, this._cycleConnection, this);
  },

  // Request                              Response
  // MUST include:  * channel             MUST include:  * channel
  //                * clientId                           * successful
  // MAY include:   * ext                                * clientId
  //                * id                  MAY include:   * error
  //                                                     * ext
  //                                                     * id
  disconnect: function() {
    if (this._state !== this.CONNECTED) return;
    this._state = this.DISCONNECTED;

    this.info('Disconnecting ?', this._dispatcher.clientId);
    var promise = new Publication();

    this._sendMessage({
      channel:  Channel.DISCONNECT,
      clientId: this._dispatcher.clientId

    }, {}, function(response) {
      if (response.successful) {
        this._dispatcher.close();
        promise.setDeferredStatus('succeeded');
      } else {
        promise.setDeferredStatus('failed', Error.parse(response.error));
      }
    }, this);

    this.info('Clearing channel listeners for ?', this._dispatcher.clientId);
    this._channels = new Channel.Set();

    return promise;
  },

  // Request                              Response
  // MUST include:  * channel             MUST include:  * channel
  //                * clientId                           * successful
  //                * subscription                       * clientId
  // MAY include:   * ext                                * subscription
  //                * id                  MAY include:   * error
  //                                                     * advice
  //                                                     * ext
  //                                                     * id
  //                                                     * timestamp
  subscribe: function(channel, callback, context) {
    if (channel instanceof Array)
      return array.map(channel, function(c) {
        return this.subscribe(c, callback, context);
      }, this);

    var subscription = new Subscription(this, channel, callback, context),
        force        = (callback === true),
        hasSubscribe = this._channels.hasSubscription(channel);

    if (hasSubscribe && !force) {
      this._channels.subscribe([channel], subscription);
      subscription.setDeferredStatus('succeeded');
      return subscription;
    }

    this.connect(function() {
      this.info('Client ? attempting to subscribe to ?', this._dispatcher.clientId, channel);
      if (!force) this._channels.subscribe([channel], subscription);

      this._sendMessage({
        channel:      Channel.SUBSCRIBE,
        clientId:     this._dispatcher.clientId,
        subscription: channel

      }, {}, function(response) {
        if (!response.successful) {
          subscription.setDeferredStatus('failed', Error.parse(response.error));
          return this._channels.unsubscribe(channel, subscription);
        }

        var channels = [].concat(response.subscription);
        this.info('Subscription acknowledged for ? to ?', this._dispatcher.clientId, channels);
        subscription.setDeferredStatus('succeeded');
      }, this);
    }, this);

    return subscription;
  },

  // Request                              Response
  // MUST include:  * channel             MUST include:  * channel
  //                * clientId                           * successful
  //                * subscription                       * clientId
  // MAY include:   * ext                                * subscription
  //                * id                  MAY include:   * error
  //                                                     * advice
  //                                                     * ext
  //                                                     * id
  //                                                     * timestamp
  unsubscribe: function(channel, subscription) {
    if (channel instanceof Array)
      return array.map(channel, function(c) {
        return this.unsubscribe(c, subscription);
      }, this);

    var dead = this._channels.unsubscribe(channel, subscription);
    if (!dead) return;

    this.connect(function() {
      this.info('Client ? attempting to unsubscribe from ?', this._dispatcher.clientId, channel);

      this._sendMessage({
        channel:      Channel.UNSUBSCRIBE,
        clientId:     this._dispatcher.clientId,
        subscription: channel

      }, {}, function(response) {
        if (!response.successful) return;

        var channels = [].concat(response.subscription);
        this.info('Unsubscription acknowledged for ? from ?', this._dispatcher.clientId, channels);
      }, this);
    }, this);
  },

  // Request                              Response
  // MUST include:  * channel             MUST include:  * channel
  //                * data                               * successful
  // MAY include:   * clientId            MAY include:   * id
  //                * id                                 * error
  //                * ext                                * ext
  publish: function(channel, data, options) {
    validateOptions(options || {}, ['attempts', 'deadline']);
    var publication = new Publication();

    this.connect(function() {
      this.info('Client ? queueing published message to ?: ?', this._dispatcher.clientId, channel, data);

      this._sendMessage({
        channel:  channel,
        data:     data,
        clientId: this._dispatcher.clientId

      }, options, function(response) {
        if (response.successful)
          publication.setDeferredStatus('succeeded');
        else
          publication.setDeferredStatus('failed', Error.parse(response.error));
      }, this);
    }, this);

    return publication;
  },

  _sendMessage: function(message, options, callback, context) {
    message.id = this._generateMessageId();

    var timeout = this._advice.timeout
                ? 1.2 * this._advice.timeout / 1000
                : 1.2 * this._dispatcher.retry;

    this.pipeThroughExtensions('outgoing', message, null, function(message) {
      if (!message) return;
      if (callback) this._responseCallbacks[message.id] = [callback, context];
      this._dispatcher.sendMessage(message, timeout, options || {});
    }, this);
  },

  _generateMessageId: function() {
    this._messageId += 1;
    if (this._messageId >= Math.pow(2,32)) this._messageId = 0;
    return this._messageId.toString(36);
  },

  _receiveMessage: function(message) {
    var id = message.id, callback;

    if (message.successful !== undefined) {
      callback = this._responseCallbacks[id];
      delete this._responseCallbacks[id];
    }

    this.pipeThroughExtensions('incoming', message, null, function(message) {
      if (!message) return;
      if (message.advice) this._handleAdvice(message.advice);
      this._deliverMessage(message);
      if (callback) callback[0].call(callback[1], message);
    }, this);
  },

  _handleAdvice: function(advice) {
    assign(this._advice, advice);
    this._dispatcher.timeout = this._advice.timeout / 1000;

    if (this._advice.reconnect === this.HANDSHAKE && this._state !== this.DISCONNECTED) {
      this._state = this.UNCONNECTED;
      this._dispatcher.clientId = null;
      this._cycleConnection();
    }
  },

  _deliverMessage: function(message) {
    if (!message.channel || message.data === undefined) return;
    this.info('Client ? calling listeners for ? with ?', this._dispatcher.clientId, message.channel, message.data);
    this._channels.distributeMessage(message);
  },

  _cycleConnection: function() {
    if (this._connectRequest) {
      this._connectRequest = null;
      this.info('Closed connection for ?', this._dispatcher.clientId);
    }
    var self = this;
    global.setTimeout(function() { self.connect() }, this._advice.interval);
  }
});

assign(Client.prototype, Deferrable);
assign(Client.prototype, Publisher);
assign(Client.prototype, Logging);
assign(Client.prototype, Extensible);

module.exports = Client;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"../mixins/deferrable":6,"../mixins/logging":7,"../mixins/publisher":8,"../util/array":26,"../util/assign":27,"../util/browser":28,"../util/class":29,"../util/constants":30,"../util/promise":34,"../util/validate_options":38,"./channel":10,"./dispatcher":12,"./error":13,"./extensible":14,"./publication":16,"./subscription":18,"asap":3}],12:[function(require,module,exports){
(function (global){
'use strict';

var Class     = require('../util/class'),
    URI       = require('../util/uri'),
    cookies   = require('../util/cookies'),
    assign    = require('../util/assign'),
    Logging   = require('../mixins/logging'),
    Publisher = require('../mixins/publisher'),
    Transport = require('../transport'),
    Scheduler = require('./scheduler');

var Dispatcher = Class({ className: 'Dispatcher',
  MAX_REQUEST_SIZE: 2048,
  DEFAULT_RETRY:    5,

  UP:   1,
  DOWN: 2,

  initialize: function(client, endpoint, options) {
    this._client     = client;
    this.endpoint    = URI.parse(endpoint);
    this._alternates = options.endpoints || {};

    this.cookies      = cookies.CookieJar && new cookies.CookieJar();
    this._disabled    = [];
    this._envelopes   = {};
    this.headers      = {};
    this.retry        = options.retry || this.DEFAULT_RETRY;
    this._scheduler   = options.scheduler || Scheduler;
    this._state       = 0;
    this.transports   = {};
    this.wsExtensions = [];

    this.proxy = options.proxy || {};
    if (typeof this._proxy === 'string') this._proxy = { origin: this._proxy };

    var exts = options.websocketExtensions;
    if (exts) {
      exts = [].concat(exts);
      for (var i = 0, n = exts.length; i < n; i++)
        this.addWebsocketExtension(exts[i]);
    }

    this.tls = options.tls || {};
    this.tls.ca = this.tls.ca || options.ca;

    for (var type in this._alternates)
      this._alternates[type] = URI.parse(this._alternates[type]);

    this.maxRequestSize = this.MAX_REQUEST_SIZE;
  },

  endpointFor: function(connectionType) {
    return this._alternates[connectionType] || this.endpoint;
  },

  addWebsocketExtension: function(extension) {
    this.wsExtensions.push(extension);
  },

  disable: function(feature) {
    this._disabled.push(feature);
    Transport.disable(feature);
  },

  setHeader: function(name, value) {
    this.headers[name] = value;
  },

  close: function() {
    var transport = this._transport;
    delete this._transport;
    if (transport) transport.close();
  },

  getConnectionTypes: function() {
    return Transport.getConnectionTypes();
  },

  selectTransport: function(transportTypes) {
    Transport.get(this, transportTypes, this._disabled, function(transport) {
      this.debug('Selected ? transport for ?', transport.connectionType, transport.endpoint.href);

      if (transport === this._transport) return;
      if (this._transport) this._transport.close();

      this._transport = transport;
      this.connectionType = transport.connectionType;
    }, this);
  },

  sendMessage: function(message, timeout, options) {
    options = options || {};

    var id       = message.id,
        attempts = options.attempts,
        deadline = options.deadline && new Date().getTime() + (options.deadline * 1000),
        envelope = this._envelopes[id],
        scheduler;

    if (!envelope) {
      scheduler = new this._scheduler(message, { timeout: timeout, interval: this.retry, attempts: attempts, deadline: deadline });
      envelope  = this._envelopes[id] = { message: message, scheduler: scheduler };
    }

    this._sendEnvelope(envelope);
  },

  _sendEnvelope: function(envelope) {
    if (!this._transport) return;
    if (envelope.request || envelope.timer) return;

    var message   = envelope.message,
        scheduler = envelope.scheduler,
        self      = this;

    if (!scheduler.isDeliverable()) {
      scheduler.abort();
      delete this._envelopes[message.id];
      return;
    }

    envelope.timer = global.setTimeout(function() {
      self.handleError(message);
    }, scheduler.getTimeout() * 1000);

    scheduler.send();
    envelope.request = this._transport.sendMessage(message);
  },

  handleResponse: function(reply) {
    var envelope = this._envelopes[reply.id];

    if (reply.successful !== undefined && envelope) {
      envelope.scheduler.succeed();
      delete this._envelopes[reply.id];
      global.clearTimeout(envelope.timer);
    }

    this.trigger('message', reply);

    if (this._state === this.UP) return;
    this._state = this.UP;
    this._client.trigger('transport:up');
  },

  handleError: function(message, immediate) {
    var envelope = this._envelopes[message.id],
        request  = envelope && envelope.request,
        self     = this;

    if (!request) return;

    request.then(function(req) {
      if (req && req.abort) req.abort();
    });

    var scheduler = envelope.scheduler;
    scheduler.fail();

    global.clearTimeout(envelope.timer);
    envelope.request = envelope.timer = null;

    if (immediate) {
      this._sendEnvelope(envelope);
    } else {
      envelope.timer = global.setTimeout(function() {
        envelope.timer = null;
        self._sendEnvelope(envelope);
      }, scheduler.getInterval() * 1000);
    }

    if (this._state === this.DOWN) return;
    this._state = this.DOWN;
    this._client.trigger('transport:down');
  }
});

Dispatcher.create = function(client, endpoint, options) {
  return new Dispatcher(client, endpoint, options);
};

assign(Dispatcher.prototype, Publisher);
assign(Dispatcher.prototype, Logging);

module.exports = Dispatcher;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"../mixins/logging":7,"../mixins/publisher":8,"../transport":19,"../util/assign":27,"../util/class":29,"../util/cookies":31,"../util/uri":37,"./scheduler":17}],13:[function(require,module,exports){
'use strict';

var Class   = require('../util/class'),
    Grammar = require('./grammar');

var Error = Class({
  initialize: function(code, params, message) {
    this.code    = code;
    this.params  = Array.prototype.slice.call(params);
    this.message = message;
  },

  toString: function() {
    return this.code + ':' +
           this.params.join(',') + ':' +
           this.message;
  }
});

Error.parse = function(message) {
  message = message || '';
  if (!Grammar.ERROR.test(message)) return new Error(null, [], message);

  var parts   = message.split(':'),
      code    = parseInt(parts[0]),
      params  = parts[1].split(','),
      message = parts[2];

  return new Error(code, params, message);
};

// http://code.google.com/p/cometd/wiki/BayeuxCodes
var errors = {
  versionMismatch:  [300, 'Version mismatch'],
  conntypeMismatch: [301, 'Connection types not supported'],
  extMismatch:      [302, 'Extension mismatch'],
  badRequest:       [400, 'Bad request'],
  clientUnknown:    [401, 'Unknown client'],
  parameterMissing: [402, 'Missing required parameter'],
  channelForbidden: [403, 'Forbidden channel'],
  channelUnknown:   [404, 'Unknown channel'],
  channelInvalid:   [405, 'Invalid channel'],
  extUnknown:       [406, 'Unknown extension'],
  publishFailed:    [407, 'Failed to publish'],
  serverError:      [500, 'Internal server error']
};

for (var name in errors)
  (function(name) {
    Error[name] = function() {
      return new Error(errors[name][0], arguments, errors[name][1]).toString();
    };
  })(name);

module.exports = Error;

},{"../util/class":29,"./grammar":15}],14:[function(require,module,exports){
'use strict';

var assign  = require('../util/assign'),
    Logging = require('../mixins/logging');

var Extensible = {
  addExtension: function(extension) {
    this._extensions = this._extensions || [];
    this._extensions.push(extension);
    if (extension.added) extension.added(this);
  },

  removeExtension: function(extension) {
    if (!this._extensions) return;
    var i = this._extensions.length;
    while (i--) {
      if (this._extensions[i] !== extension) continue;
      this._extensions.splice(i,1);
      if (extension.removed) extension.removed(this);
    }
  },

  pipeThroughExtensions: function(stage, message, request, callback, context) {
    this.debug('Passing through ? extensions: ?', stage, message);

    if (!this._extensions) return callback.call(context, message);
    var extensions = this._extensions.slice();

    var pipe = function(message) {
      if (!message) return callback.call(context, message);

      var extension = extensions.shift();
      if (!extension) return callback.call(context, message);

      var fn = extension[stage];
      if (!fn) return pipe(message);

      if (fn.length >= 3) extension[stage](message, request, pipe);
      else                extension[stage](message, pipe);
    };
    pipe(message);
  }
};

assign(Extensible, Logging);

module.exports = Extensible;

},{"../mixins/logging":7,"../util/assign":27}],15:[function(require,module,exports){
'use strict';

module.exports = {
  CHANNEL_NAME:     /^\/(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)))+(\/(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)))+)*$/,
  CHANNEL_PATTERN:  /^(\/(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)))+)*\/\*{1,2}$/,
  ERROR:            /^([0-9][0-9][0-9]:(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)| |\/|\*|\.))*(,(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)| |\/|\*|\.))*)*:(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)| |\/|\*|\.))*|[0-9][0-9][0-9]::(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)| |\/|\*|\.))*)$/,
  VERSION:          /^([0-9])+(\.(([a-z]|[A-Z])|[0-9])(((([a-z]|[A-Z])|[0-9])|\-|\_))*)*$/
};

},{}],16:[function(require,module,exports){
'use strict';

var Class      = require('../util/class'),
    Deferrable = require('../mixins/deferrable');

module.exports = Class(Deferrable);

},{"../mixins/deferrable":6,"../util/class":29}],17:[function(require,module,exports){
'use strict';

var assign = require('../util/assign');

var Scheduler = function(message, options) {
  this.message  = message;
  this.options  = options;
  this.attempts = 0;
};

assign(Scheduler.prototype, {
  getTimeout: function() {
    return this.options.timeout;
  },

  getInterval: function() {
    return this.options.interval;
  },

  isDeliverable: function() {
    var attempts = this.options.attempts,
        made     = this.attempts,
        deadline = this.options.deadline,
        now      = new Date().getTime();

    if (attempts !== undefined && made >= attempts)
      return false;

    if (deadline !== undefined && now > deadline)
      return false;

    return true;
  },

  send: function() {
    this.attempts += 1;
  },

  succeed: function() {},

  fail: function() {},

  abort: function() {}
});

module.exports = Scheduler;

},{"../util/assign":27}],18:[function(require,module,exports){
'use strict';

var Class      = require('../util/class'),
    assign     = require('../util/assign'),
    Deferrable = require('../mixins/deferrable');

var Subscription = Class({
  initialize: function(client, channels, callback, context) {
    this._client    = client;
    this._channels  = channels;
    this._callback  = callback;
    this._context   = context;
    this._cancelled = false;
  },

  withChannel: function(callback, context) {
    this._withChannel = [callback, context];
    return this;
  },

  apply: function(context, args) {
    var message = args[0];

    if (this._callback)
      this._callback.call(this._context, message.data);

    if (this._withChannel)
      this._withChannel[0].call(this._withChannel[1], message.channel, message.data);
  },

  cancel: function() {
    if (this._cancelled) return;
    this._client.unsubscribe(this._channels, this);
    this._cancelled = true;
  },

  unsubscribe: function() {
    this.cancel();
  }
});

assign(Subscription.prototype, Deferrable);

module.exports = Subscription;

},{"../mixins/deferrable":6,"../util/assign":27,"../util/class":29}],19:[function(require,module,exports){
'use strict';

var Transport = require('./transport');

Transport.register('websocket', require('./web_socket'));
Transport.register('eventsource', require('./event_source'));
Transport.register('long-polling', require('./xhr'));
Transport.register('cross-origin-long-polling', require('./cors'));
Transport.register('callback-polling', require('./jsonp'));

module.exports = Transport;

},{"./cors":20,"./event_source":21,"./jsonp":22,"./transport":23,"./web_socket":24,"./xhr":25}],20:[function(require,module,exports){
(function (global){
'use strict';

var Class     = require('../util/class'),
    Set       = require('../util/set'),
    URI       = require('../util/uri'),
    assign    = require('../util/assign'),
    toJSON    = require('../util/to_json'),
    Transport = require('./transport');

var CORS = assign(Class(Transport, {
  encode: function(messages) {
    return 'message=' + encodeURIComponent(toJSON(messages));
  },

  request: function(messages) {
    var xhrClass = global.XDomainRequest ? XDomainRequest : XMLHttpRequest,
        xhr      = new xhrClass(),
        id       = ++CORS._id,
        headers  = this._dispatcher.headers,
        self     = this,
        key;

    xhr.open('POST', this.endpoint.href, true);
    xhr.withCredentials = true;

    if (xhr.setRequestHeader) {
      xhr.setRequestHeader('Pragma', 'no-cache');
      for (key in headers) {
        if (!headers.hasOwnProperty(key)) continue;
        xhr.setRequestHeader(key, headers[key]);
      }
    }

    var cleanUp = function() {
      if (!xhr) return false;
      CORS._pending.remove(id);
      xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onprogress = null;
      xhr = null;
    };

    xhr.onload = function() {
      var replies;
      try { replies = JSON.parse(xhr.responseText) } catch (error) {}

      cleanUp();

      if (replies)
        self._receive(replies);
      else
        self._handleError(messages);
    };

    xhr.onerror = xhr.ontimeout = function() {
      cleanUp();
      self._handleError(messages);
    };

    xhr.onprogress = function() {};

    if (xhrClass === global.XDomainRequest)
      CORS._pending.add({ id: id, xhr: xhr });

    xhr.send(this.encode(messages));
    return xhr;
  }
}), {
  _id:      0,
  _pending: new Set(),

  isUsable: function(dispatcher, endpoint, callback, context) {
    if (URI.isSameOrigin(endpoint))
      return callback.call(context, false);

    if (global.XDomainRequest)
      return callback.call(context, endpoint.protocol === location.protocol);

    if (global.XMLHttpRequest) {
      var xhr = new XMLHttpRequest();
      return callback.call(context, xhr.withCredentials !== undefined);
    }
    return callback.call(context, false);
  }
});

module.exports = CORS;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"../util/assign":27,"../util/class":29,"../util/set":35,"../util/to_json":36,"../util/uri":37,"./transport":23}],21:[function(require,module,exports){
(function (global){
'use strict';

var Class      = require('../util/class'),
    URI        = require('../util/uri'),
    copyObject = require('../util/copy_object'),
    assign     = require('../util/assign'),
    Deferrable = require('../mixins/deferrable'),
    Transport  = require('./transport'),
    XHR        = require('./xhr');

var EventSource = assign(Class(Transport, {
  initialize: function(dispatcher, endpoint) {
    Transport.prototype.initialize.call(this, dispatcher, endpoint);
    if (!global.EventSource) return this.setDeferredStatus('failed');

    this._xhr = new XHR(dispatcher, endpoint);

    endpoint = copyObject(endpoint);
    endpoint.pathname += '/' + dispatcher.clientId;

    var socket = new global.EventSource(URI.stringify(endpoint)),
        self   = this;

    socket.onopen = function() {
      self._everConnected = true;
      self.setDeferredStatus('succeeded');
    };

    socket.onerror = function() {
      if (self._everConnected) {
        self._handleError([]);
      } else {
        self.setDeferredStatus('failed');
        socket.close();
      }
    };

    socket.onmessage = function(event) {
      var replies;
      try { replies = JSON.parse(event.data) } catch (error) {}

      if (replies)
        self._receive(replies);
      else
        self._handleError([]);
    };

    this._socket = socket;
  },

  close: function() {
    if (!this._socket) return;
    this._socket.onopen = this._socket.onerror = this._socket.onmessage = null;
    this._socket.close();
    delete this._socket;
  },

  isUsable: function(callback, context) {
    this.callback(function() { callback.call(context, true) });
    this.errback(function() { callback.call(context, false) });
  },

  encode: function(messages) {
    return this._xhr.encode(messages);
  },

  request: function(messages) {
    return this._xhr.request(messages);
  }

}), {
  isUsable: function(dispatcher, endpoint, callback, context) {
    var id = dispatcher.clientId;
    if (!id) return callback.call(context, false);

    XHR.isUsable(dispatcher, endpoint, function(usable) {
      if (!usable) return callback.call(context, false);
      this.create(dispatcher, endpoint).isUsable(callback, context);
    }, this);
  },

  create: function(dispatcher, endpoint) {
    var sockets = dispatcher.transports.eventsource = dispatcher.transports.eventsource || {},
        id      = dispatcher.clientId;

    var url = copyObject(endpoint);
    url.pathname += '/' + (id || '');
    url = URI.stringify(url);

    sockets[url] = sockets[url] || new this(dispatcher, endpoint);
    return sockets[url];
  }
});

assign(EventSource.prototype, Deferrable);

module.exports = EventSource;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"../mixins/deferrable":6,"../util/assign":27,"../util/class":29,"../util/copy_object":32,"../util/uri":37,"./transport":23,"./xhr":25}],22:[function(require,module,exports){
(function (global){
'use strict';

var Class      = require('../util/class'),
    URI        = require('../util/uri'),
    copyObject = require('../util/copy_object'),
    assign     = require('../util/assign'),
    toJSON     = require('../util/to_json'),
    Transport  = require('./transport');

var JSONP = assign(Class(Transport, {
 encode: function(messages) {
    var url = copyObject(this.endpoint);
    url.query.message = toJSON(messages);
    url.query.jsonp   = '__jsonp' + JSONP._cbCount + '__';
    return URI.stringify(url);
  },

  request: function(messages) {
    var head         = document.getElementsByTagName('head')[0],
        script       = document.createElement('script'),
        callbackName = JSONP.getCallbackName(),
        endpoint     = copyObject(this.endpoint),
        self         = this;

    endpoint.query.message = toJSON(messages);
    endpoint.query.jsonp   = callbackName;

    var cleanup = function() {
      if (!global[callbackName]) return false;
      global[callbackName] = undefined;
      try { delete global[callbackName] } catch (error) {}
      script.parentNode.removeChild(script);
    };

    global[callbackName] = function(replies) {
      cleanup();
      self._receive(replies);
    };

    script.type = 'text/javascript';
    script.src  = URI.stringify(endpoint);
    head.appendChild(script);

    script.onerror = function() {
      cleanup();
      self._handleError(messages);
    };

    return { abort: cleanup };
  }
}), {
  _cbCount: 0,

  getCallbackName: function() {
    this._cbCount += 1;
    return '__jsonp' + this._cbCount + '__';
  },

  isUsable: function(dispatcher, endpoint, callback, context) {
    callback.call(context, true);
  }
});

module.exports = JSONP;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"../util/assign":27,"../util/class":29,"../util/copy_object":32,"../util/to_json":36,"../util/uri":37,"./transport":23}],23:[function(require,module,exports){
(function (process){
'use strict';

var Class    = require('../util/class'),
    Cookie   = require('../util/cookies').Cookie,
    Promise  = require('../util/promise'),
    array    = require('../util/array'),
    assign   = require('../util/assign'),
    Logging  = require('../mixins/logging'),
    Timeouts = require('../mixins/timeouts'),
    Channel  = require('../protocol/channel');

var Transport = assign(Class({ className: 'Transport',
  DEFAULT_PORTS: { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 },
  MAX_DELAY:     0,

  batching:  true,

  initialize: function(dispatcher, endpoint) {
    this._dispatcher = dispatcher;
    this.endpoint    = endpoint;
    this._outbox     = [];
    this._proxy      = assign({}, this._dispatcher.proxy);

    if (!this._proxy.origin)
      this._proxy.origin = this._findProxy();
  },

  close: function() {},

  encode: function(messages) {
    return '';
  },

  sendMessage: function(message) {
    this.debug('Client ? sending message to ?: ?',
               this._dispatcher.clientId, this.endpoint.href, message);

    if (!this.batching) return Promise.resolve(this.request([message]));

    this._outbox.push(message);
    this._flushLargeBatch();

    if (message.channel === Channel.HANDSHAKE)
      return this._publish(0.01);

    if (message.channel === Channel.CONNECT)
      this._connectMessage = message;

    return this._publish(this.MAX_DELAY);
  },

  _makePromise: function() {
    var self = this;

    this._requestPromise = this._requestPromise || new Promise(function(resolve) {
      self._resolvePromise = resolve;
    });
  },

  _publish: function(delay) {
    this._makePromise();

    this.addTimeout('publish', delay, function() {
      this._flush();
      delete this._requestPromise;
    }, this);

    return this._requestPromise;
  },

  _flush: function() {
    this.removeTimeout('publish');

    if (this._outbox.length > 1 && this._connectMessage)
      this._connectMessage.advice = { timeout: 0 };

    this._resolvePromise(this.request(this._outbox));

    this._connectMessage = null;
    this._outbox = [];
  },

  _flushLargeBatch: function() {
    var string = this.encode(this._outbox);
    if (string.length < this._dispatcher.maxRequestSize) return;
    var last = this._outbox.pop();

    this._makePromise();
    this._flush();

    if (last) this._outbox.push(last);
  },

  _receive: function(replies) {
    if (!replies) return;
    replies = [].concat(replies);

    this.debug('Client ? received from ? via ?: ?',
               this._dispatcher.clientId, this.endpoint.href, this.connectionType, replies);

    for (var i = 0, n = replies.length; i < n; i++)
      this._dispatcher.handleResponse(replies[i]);
  },

  _handleError: function(messages, immediate) {
    messages = [].concat(messages);

    this.debug('Client ? failed to send to ? via ?: ?',
               this._dispatcher.clientId, this.endpoint.href, this.connectionType, messages);

    for (var i = 0, n = messages.length; i < n; i++)
      this._dispatcher.handleError(messages[i]);
  },

  _getCookies: function() {
    var cookies = this._dispatcher.cookies,
        url     = this.endpoint.href;

    if (!cookies) return '';

    return array.map(cookies.getCookiesSync(url), function(cookie) {
      return cookie.cookieString();
    }).join('; ');
  },

  _storeCookies: function(setCookie) {
    var cookies = this._dispatcher.cookies,
        url     = this.endpoint.href,
        cookie;

    if (!setCookie || !cookies) return;
    setCookie = [].concat(setCookie);

    for (var i = 0, n = setCookie.length; i < n; i++) {
      cookie = Cookie.parse(setCookie[i]);
      cookies.setCookieSync(cookie, url);
    }
  },

  _findProxy: function() {
    if (typeof process === 'undefined') return undefined;

    var protocol = this.endpoint.protocol;
    if (!protocol) return undefined;

    var name   = protocol.replace(/:$/, '').toLowerCase() + '_proxy',
        upcase = name.toUpperCase(),
        env    = process.env,
        keys, proxy;

    if (name === 'http_proxy' && env.REQUEST_METHOD) {
      keys = Object.keys(env).filter(function(k) { return /^http_proxy$/i.test(k) });
      if (keys.length === 1) {
        if (keys[0] === name && env[upcase] === undefined)
          proxy = env[name];
      } else if (keys.length > 1) {
        proxy = env[name];
      }
      proxy = proxy || env['CGI_' + upcase];
    } else {
      proxy = env[name] || env[upcase];
      if (proxy && !env[name])
        console.warn('The environment variable ' + upcase +
                     ' is discouraged. Use ' + name + '.');
    }
    return proxy;
  }

}), {
  get: function(dispatcher, allowed, disabled, callback, context) {
    var endpoint = dispatcher.endpoint;

    array.asyncEach(this._transports, function(pair, resume) {
      var connType     = pair[0], klass = pair[1],
          connEndpoint = dispatcher.endpointFor(connType);

      if (array.indexOf(disabled, connType) >= 0)
        return resume();

      if (array.indexOf(allowed, connType) < 0) {
        klass.isUsable(dispatcher, connEndpoint, function() {});
        return resume();
      }

      klass.isUsable(dispatcher, connEndpoint, function(isUsable) {
        if (!isUsable) return resume();
        var transport = klass.hasOwnProperty('create') ? klass.create(dispatcher, connEndpoint) : new klass(dispatcher, connEndpoint);
        callback.call(context, transport);
      });
    }, function() {
      throw new Error('Could not find a usable connection type for ' + endpoint.href);
    });
  },

  register: function(type, klass) {
    this._transports.push([type, klass]);
    klass.prototype.connectionType = type;
  },

  getConnectionTypes: function() {
    return array.map(this._transports, function(t) { return t[0] });
  },

  disable: function(feature) {
    if (feature !== 'autodisconnect') return;

    for (var i = 0; i < this._transports.length; i++)
      this._transports[i][1]._unloaded = false;
  },

  _transports: []
});

assign(Transport.prototype, Logging);
assign(Transport.prototype, Timeouts);

module.exports = Transport;

}).call(this,require('_process'))

},{"../mixins/logging":7,"../mixins/timeouts":9,"../protocol/channel":10,"../util/array":26,"../util/assign":27,"../util/class":29,"../util/cookies":31,"../util/promise":34,"_process":40}],24:[function(require,module,exports){
(function (global){
'use strict';

var Class      = require('../util/class'),
    Promise    = require('../util/promise'),
    Set        = require('../util/set'),
    URI        = require('../util/uri'),
    browser    = require('../util/browser'),
    copyObject = require('../util/copy_object'),
    assign     = require('../util/assign'),
    toJSON     = require('../util/to_json'),
    ws         = require('../util/websocket'),
    Deferrable = require('../mixins/deferrable'),
    Transport  = require('./transport');

var WebSocket = assign(Class(Transport, {
  UNCONNECTED:  1,
  CONNECTING:   2,
  CONNECTED:    3,

  batching:     false,

  isUsable: function(callback, context) {
    this.callback(function() { callback.call(context, true) });
    this.errback(function() { callback.call(context, false) });
    this.connect();
  },

  request: function(messages) {
    this._pending = this._pending || new Set();
    for (var i = 0, n = messages.length; i < n; i++) this._pending.add(messages[i]);

    var self = this;

    var promise = new Promise(function(resolve, reject) {
      self.callback(function(socket) {
        if (!socket || socket.readyState !== 1) return;
        socket.send(toJSON(messages));
        resolve(socket);
      });

      self.connect();
    });

    return {
      abort: function() { promise.then(function(ws) { ws.close() }) }
    };
  },

  connect: function() {
    if (WebSocket._unloaded) return;

    this._state = this._state || this.UNCONNECTED;
    if (this._state !== this.UNCONNECTED) return;
    this._state = this.CONNECTING;

    var socket = this._createSocket();
    if (!socket) return this.setDeferredStatus('failed');

    var self = this;

    socket.onopen = function() {
      if (socket.headers) self._storeCookies(socket.headers['set-cookie']);
      self._socket = socket;
      self._state = self.CONNECTED;
      self._everConnected = true;
      self.setDeferredStatus('succeeded', socket);
    };

    var closed = false;
    socket.onclose = socket.onerror = function() {
      if (closed) return;
      closed = true;

      var wasConnected = (self._state === self.CONNECTED);
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;

      delete self._socket;
      self._state = self.UNCONNECTED;

      var pending = self._pending ? self._pending.toArray() : [];
      delete self._pending;

      if (wasConnected || self._everConnected) {
        self.setDeferredStatus('unknown');
        self._handleError(pending, wasConnected);
      } else {
        self.setDeferredStatus('failed');
      }
    };

    socket.onmessage = function(event) {
      var replies;
      try { replies = JSON.parse(event.data) } catch (error) {}

      if (!replies) return;

      replies = [].concat(replies);

      for (var i = 0, n = replies.length; i < n; i++) {
        if (replies[i].successful === undefined) continue;
        self._pending.remove(replies[i]);
      }
      self._receive(replies);
    };
  },

  close: function() {
    if (!this._socket) return;
    this._socket.close();
  },

  _createSocket: function() {
    var url        = WebSocket.getSocketUrl(this.endpoint),
        headers    = this._dispatcher.headers,
        extensions = this._dispatcher.wsExtensions,
        cookie     = this._getCookies(),
        tls        = this._dispatcher.tls,
        options    = { extensions: extensions, headers: headers, proxy: this._proxy, tls: tls };

    if (cookie !== '') options.headers['Cookie'] = cookie;

    try {
      return ws.create(url, [], options);
    } catch (e) {
      // catch CSP error to allow transport to fallback to next connType
    }
  }

}), {
  PROTOCOLS: {
    'http:':  'ws:',
    'https:': 'wss:'
  },

  create: function(dispatcher, endpoint) {
    var sockets = dispatcher.transports.websocket = dispatcher.transports.websocket || {};
    sockets[endpoint.href] = sockets[endpoint.href] || new this(dispatcher, endpoint);
    return sockets[endpoint.href];
  },

  getSocketUrl: function(endpoint) {
    endpoint = copyObject(endpoint);
    endpoint.protocol = this.PROTOCOLS[endpoint.protocol];
    return URI.stringify(endpoint);
  },

  isUsable: function(dispatcher, endpoint, callback, context) {
    this.create(dispatcher, endpoint).isUsable(callback, context);
  }
});

assign(WebSocket.prototype, Deferrable);

if (browser.Event && global.onbeforeunload !== undefined) {
  browser.Event.on(global, 'beforeunload', function() {
    if (WebSocket._unloaded === undefined)
      WebSocket._unloaded = true;
  });
}

module.exports = WebSocket;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"../mixins/deferrable":6,"../util/assign":27,"../util/browser":28,"../util/class":29,"../util/copy_object":32,"../util/promise":34,"../util/set":35,"../util/to_json":36,"../util/uri":37,"../util/websocket":39,"./transport":23}],25:[function(require,module,exports){
(function (global){
'use strict';

var Class     = require('../util/class'),
    URI       = require('../util/uri'),
    browser   = require('../util/browser'),
    assign    = require('../util/assign'),
    toJSON    = require('../util/to_json'),
    Transport = require('./transport');

var XHR = assign(Class(Transport, {
  encode: function(messages) {
    return toJSON(messages);
  },

  request: function(messages) {
    var href = this.endpoint.href,
        self = this,
        xhr;

    // Prefer XMLHttpRequest over ActiveXObject if they both exist
    if (global.XMLHttpRequest) {
      xhr = new XMLHttpRequest();
    } else if (global.ActiveXObject) {
      xhr = new ActiveXObject('Microsoft.XMLHTTP');
    } else {
      return this._handleError(messages);
    }

    xhr.open('POST', href, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Pragma', 'no-cache');
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');

    var headers = this._dispatcher.headers;
    for (var key in headers) {
      if (!headers.hasOwnProperty(key)) continue;
      xhr.setRequestHeader(key, headers[key]);
    }

    var abort = function() { xhr.abort() };
    if (global.onbeforeunload !== undefined)
      browser.Event.on(global, 'beforeunload', abort);

    xhr.onreadystatechange = function() {
      if (!xhr || xhr.readyState !== 4) return;

      var replies    = null,
          status     = xhr.status,
          text       = xhr.responseText,
          successful = (status >= 200 && status < 300) || status === 304 || status === 1223;

      if (global.onbeforeunload !== undefined)
        browser.Event.detach(global, 'beforeunload', abort);

      xhr.onreadystatechange = function() {};
      xhr = null;

      if (!successful) return self._handleError(messages);

      try {
        replies = JSON.parse(text);
      } catch (error) {}

      if (replies)
        self._receive(replies);
      else
        self._handleError(messages);
    };

    xhr.send(this.encode(messages));
    return xhr;
  }
}), {
  isUsable: function(dispatcher, endpoint, callback, context) {
    var usable = (navigator.product === 'ReactNative')
              || URI.isSameOrigin(endpoint);

    callback.call(context, usable);
  }
});

module.exports = XHR;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"../util/assign":27,"../util/browser":28,"../util/class":29,"../util/to_json":36,"../util/uri":37,"./transport":23}],26:[function(require,module,exports){
'use strict';

module.exports = {
  commonElement: function(lista, listb) {
    for (var i = 0, n = lista.length; i < n; i++) {
      if (this.indexOf(listb, lista[i]) !== -1)
        return lista[i];
    }
    return null;
  },

  indexOf: function(list, needle) {
    if (list.indexOf) return list.indexOf(needle);

    for (var i = 0, n = list.length; i < n; i++) {
      if (list[i] === needle) return i;
    }
    return -1;
  },

  map: function(object, callback, context) {
    if (object.map) return object.map(callback, context);
    var result = [];

    if (object instanceof Array) {
      for (var i = 0, n = object.length; i < n; i++) {
        result.push(callback.call(context || null, object[i], i));
      }
    } else {
      for (var key in object) {
        if (!object.hasOwnProperty(key)) continue;
        result.push(callback.call(context || null, key, object[key]));
      }
    }
    return result;
  },

  filter: function(array, callback, context) {
    if (array.filter) return array.filter(callback, context);
    var result = [];
    for (var i = 0, n = array.length; i < n; i++) {
      if (callback.call(context || null, array[i], i))
        result.push(array[i]);
    }
    return result;
  },

  asyncEach: function(list, iterator, callback, context) {
    var n       = list.length,
        i       = -1,
        calls   = 0,
        looping = false;

    var iterate = function() {
      calls -= 1;
      i += 1;
      if (i === n) return callback && callback.call(context);
      iterator(list[i], resume);
    };

    var loop = function() {
      if (looping) return;
      looping = true;
      while (calls > 0) iterate();
      looping = false;
    };

    var resume = function() {
      calls += 1;
      loop();
    };
    resume();
  }
};

},{}],27:[function(require,module,exports){
'use strict';

var forEach = Array.prototype.forEach,
    hasOwn  = Object.prototype.hasOwnProperty;

module.exports = function(target) {
  forEach.call(arguments, function(source, i) {
    if (i === 0) return;

    for (var key in source) {
      if (hasOwn.call(source, key)) target[key] = source[key];
    }
  });

  return target;
};

},{}],28:[function(require,module,exports){
(function (global){
'use strict';

var Event = {
  _registry: [],

  on: function(element, eventName, callback, context) {
    var wrapped = function() { callback.call(context) };

    if (element.addEventListener)
      element.addEventListener(eventName, wrapped, false);
    else
      element.attachEvent('on' + eventName, wrapped);

    this._registry.push({
      _element:   element,
      _type:      eventName,
      _callback:  callback,
      _context:     context,
      _handler:   wrapped
    });
  },

  detach: function(element, eventName, callback, context) {
    var i = this._registry.length, register;
    while (i--) {
      register = this._registry[i];

      if ((element    && element    !== register._element)  ||
          (eventName  && eventName  !== register._type)     ||
          (callback   && callback   !== register._callback) ||
          (context    && context    !== register._context))
        continue;

      if (register._element.removeEventListener)
        register._element.removeEventListener(register._type, register._handler, false);
      else
        register._element.detachEvent('on' + register._type, register._handler);

      this._registry.splice(i,1);
      register = null;
    }
  }
};

if (global.onunload !== undefined)
  Event.on(global, 'unload', Event.detach, Event);

module.exports = {
  Event: Event
};

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],29:[function(require,module,exports){
'use strict';

var assign = require('./assign');

module.exports = function(parent, methods) {
  if (typeof parent !== 'function') {
    methods = parent;
    parent  = Object;
  }

  var klass = function() {
    if (!this.initialize) return this;
    return this.initialize.apply(this, arguments) || this;
  };

  var bridge = function() {};
  bridge.prototype = parent.prototype;

  klass.prototype = new bridge();
  assign(klass.prototype, methods);

  return klass;
};

},{"./assign":27}],30:[function(require,module,exports){
module.exports = {
  VERSION:          '1.4.0',

  BAYEUX_VERSION:   '1.0',
  ID_LENGTH:        160,
  JSONP_CALLBACK:   'jsonpcallback',
  CONNECTION_TYPES: ['long-polling', 'cross-origin-long-polling', 'callback-polling', 'websocket', 'eventsource', 'in-process'],

  MANDATORY_CONNECTION_TYPES: ['long-polling', 'callback-polling', 'in-process']
};

},{}],31:[function(require,module,exports){
'use strict';

module.exports = {};

},{}],32:[function(require,module,exports){
'use strict';

var copyObject = function(object) {
  var clone, i, key;
  if (object instanceof Array) {
    clone = [];
    i = object.length;
    while (i--) clone[i] = copyObject(object[i]);
    return clone;
  } else if (typeof object === 'object') {
    clone = (object === null) ? null : {};
    for (key in object) clone[key] = copyObject(object[key]);
    return clone;
  } else {
    return object;
  }
};

module.exports = copyObject;

},{}],33:[function(require,module,exports){
/*
Copyright Joyent, Inc. and other Node contributors. All rights reserved.
Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

var isArray = typeof Array.isArray === 'function'
    ? Array.isArray
    : function (xs) {
        return Object.prototype.toString.call(xs) === '[object Array]'
    }
;
function indexOf (xs, x) {
    if (xs.indexOf) return xs.indexOf(x);
    for (var i = 0; i < xs.length; i++) {
        if (x === xs[i]) return i;
    }
    return -1;
}

function EventEmitter() {}
module.exports = EventEmitter;

EventEmitter.prototype.emit = function(type) {
  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events || !this._events.error ||
        (isArray(this._events.error) && !this._events.error.length))
    {
      if (arguments[1] instanceof Error) {
        throw arguments[1]; // Unhandled 'error' event
      } else {
        throw new Error("Uncaught, unspecified 'error' event.");
      }
      return false;
    }
  }

  if (!this._events) return false;
  var handler = this._events[type];
  if (!handler) return false;

  if (typeof handler == 'function') {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        var args = Array.prototype.slice.call(arguments, 1);
        handler.apply(this, args);
    }
    return true;

  } else if (isArray(handler)) {
    var args = Array.prototype.slice.call(arguments, 1);

    var listeners = handler.slice();
    for (var i = 0, l = listeners.length; i < l; i++) {
      listeners[i].apply(this, args);
    }
    return true;

  } else {
    return false;
  }
};

// EventEmitter is defined in src/node_events.cc
// EventEmitter.prototype.emit() is also defined there.
EventEmitter.prototype.addListener = function(type, listener) {
  if ('function' !== typeof listener) {
    throw new Error('addListener only takes instances of Function');
  }

  if (!this._events) this._events = {};

  // To avoid recursion in the case that type == "newListeners"! Before
  // adding it to the listeners, first emit "newListeners".
  this.emit('newListener', type, listener);

  if (!this._events[type]) {
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  } else if (isArray(this._events[type])) {
    // If we've already got an array, just append.
    this._events[type].push(listener);
  } else {
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  var self = this;
  self.on(type, function g() {
    self.removeListener(type, g);
    listener.apply(this, arguments);
  });

  return this;
};

EventEmitter.prototype.removeListener = function(type, listener) {
  if ('function' !== typeof listener) {
    throw new Error('removeListener only takes instances of Function');
  }

  // does not use listeners(), so no side effect of creating _events[type]
  if (!this._events || !this._events[type]) return this;

  var list = this._events[type];

  if (isArray(list)) {
    var i = indexOf(list, listener);
    if (i < 0) return this;
    list.splice(i, 1);
    if (list.length == 0)
      delete this._events[type];
  } else if (this._events[type] === listener) {
    delete this._events[type];
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  if (arguments.length === 0) {
    this._events = {};
    return this;
  }

  // does not use listeners(), so no side effect of creating _events[type]
  if (type && this._events && this._events[type]) this._events[type] = null;
  return this;
};

EventEmitter.prototype.listeners = function(type) {
  if (!this._events) this._events = {};
  if (!this._events[type]) this._events[type] = [];
  if (!isArray(this._events[type])) {
    this._events[type] = [this._events[type]];
  }
  return this._events[type];
};

},{}],34:[function(require,module,exports){
'use strict';

var asap = require('asap');

var PENDING   = -1,
    FULFILLED =  0,
    REJECTED  =  1;

var Promise = function(task) {
  this._state = PENDING;
  this._value = null;
  this._defer = [];

  execute(this, task);
};

Promise.prototype.then = function(onFulfilled, onRejected) {
  var promise = new Promise();

  var deferred = {
    promise:     promise,
    onFulfilled: onFulfilled,
    onRejected:  onRejected
  };

  if (this._state === PENDING)
    this._defer.push(deferred);
  else
    propagate(this, deferred);

  return promise;
};

Promise.prototype['catch'] = function(onRejected) {
  return this.then(null, onRejected);
};

var execute = function(promise, task) {
  if (typeof task !== 'function') return;

  var calls = 0;

  var resolvePromise = function(value) {
    if (calls++ === 0) resolve(promise, value);
  };

  var rejectPromise = function(reason) {
    if (calls++ === 0) reject(promise, reason);
  };

  try {
    task(resolvePromise, rejectPromise);
  } catch (error) {
    rejectPromise(error);
  }
};

var propagate = function(promise, deferred) {
  var state   = promise._state,
      value   = promise._value,
      next    = deferred.promise,
      handler = [deferred.onFulfilled, deferred.onRejected][state],
      pass    = [resolve, reject][state];

  if (typeof handler !== 'function')
    return pass(next, value);

  asap(function() {
    try {
      resolve(next, handler(value));
    } catch (error) {
      reject(next, error);
    }
  });
};

var resolve = function(promise, value) {
  if (promise === value)
    return reject(promise, new TypeError('Recursive promise chain detected'));

  var then;

  try {
    then = getThen(value);
  } catch (error) {
    return reject(promise, error);
  }

  if (!then) return fulfill(promise, value);

  execute(promise, function(resolvePromise, rejectPromise) {
    then.call(value, resolvePromise, rejectPromise);
  });
};

var getThen = function(value) {
  var type = typeof value,
      then = (type === 'object' || type === 'function') && value && value.then;

  return (typeof then === 'function')
         ? then
         : null;
};

var fulfill = function(promise, value) {
  settle(promise, FULFILLED, value);
};

var reject = function(promise, reason) {
  settle(promise, REJECTED, reason);
};

var settle = function(promise, state, value) {
  var defer = promise._defer, i = 0;

  promise._state = state;
  promise._value = value;
  promise._defer = null;

  if (defer.length === 0) return;
  while (i < defer.length) propagate(promise, defer[i++]);
};

Promise.resolve = function(value) {
  try {
    if (getThen(value)) return value;
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise(function(resolve, reject) { resolve(value) });
};

Promise.reject = function(reason) {
  return new Promise(function(resolve, reject) { reject(reason) });
};

Promise.all = function(promises) {
  return new Promise(function(resolve, reject) {
    var list = [], n = promises.length, i;

    if (n === 0) return resolve(list);

    var push = function(promise, i) {
      Promise.resolve(promise).then(function(value) {
        list[i] = value;
        if (--n === 0) resolve(list);
      }, reject);
    };

    for (i = 0; i < n; i++) push(promises[i], i);
  });
};

Promise.race = function(promises) {
  return new Promise(function(resolve, reject) {
    for (var i = 0, n = promises.length; i < n; i++)
      Promise.resolve(promises[i]).then(resolve, reject);
  });
};

Promise.deferred = function() {
  var tuple = {};

  tuple.promise = new Promise(function(resolve, reject) {
    tuple.resolve = resolve;
    tuple.reject  = reject;
  });
  return tuple;
};

module.exports = Promise;

},{"asap":3}],35:[function(require,module,exports){
'use strict';

var Class = require('./class');

module.exports = Class({
  initialize: function() {
    this._index = {};
  },

  add: function(item) {
    var key = (item.id !== undefined) ? item.id : item;
    if (this._index.hasOwnProperty(key)) return false;
    this._index[key] = item;
    return true;
  },

  forEach: function(block, context) {
    for (var key in this._index) {
      if (this._index.hasOwnProperty(key))
        block.call(context, this._index[key]);
    }
  },

  isEmpty: function() {
    for (var key in this._index) {
      if (this._index.hasOwnProperty(key)) return false;
    }
    return true;
  },

  member: function(item) {
    for (var key in this._index) {
      if (this._index[key] === item) return true;
    }
    return false;
  },

  remove: function(item) {
    var key = (item.id !== undefined) ? item.id : item;
    var removed = this._index[key];
    delete this._index[key];
    return removed;
  },

  toArray: function() {
    var array = [];
    this.forEach(function(item) { array.push(item) });
    return array;
  }
});

},{"./class":29}],36:[function(require,module,exports){
'use strict';

// http://assanka.net/content/tech/2009/09/02/json2-js-vs-prototype/

module.exports = function(object) {
  return JSON.stringify(object, function(key, value) {
    return (this[key] instanceof Array) ? this[key] : value;
  });
};

},{}],37:[function(require,module,exports){
'use strict';

module.exports = {
  isURI: function(uri) {
    return uri && uri.protocol && uri.host && uri.path;
  },

  isSameOrigin: function(uri) {
    return uri.protocol === location.protocol &&
           uri.hostname === location.hostname &&
           uri.port     === location.port;
  },

  parse: function(url) {
    if (typeof url !== 'string') return url;
    var uri = {}, parts, query, pairs, i, n, data;

    var consume = function(name, pattern) {
      url = url.replace(pattern, function(match) {
        uri[name] = match;
        return '';
      });
      uri[name] = uri[name] || '';
    };

    consume('protocol', /^[a-z]+\:/i);
    consume('host',     /^\/\/[^\/\?#]+/);

    if (!/^\//.test(url) && !uri.host)
      url = location.pathname.replace(/[^\/]*$/, '') + url;

    consume('pathname', /^[^\?#]*/);
    consume('search',   /^\?[^#]*/);
    consume('hash',     /^#.*/);

    uri.protocol = uri.protocol || location.protocol;

    if (uri.host) {
      uri.host = uri.host.substr(2);

      if (/@/.test(uri.host)) {
        uri.auth = uri.host.split('@')[0];
        uri.host = uri.host.split('@')[1];
      }
      parts        = uri.host.match(/^\[([^\]]+)\]|^[^:]+/);
      uri.hostname = parts[1] || parts[0];
      uri.port     = (uri.host.match(/:(\d+)$/) || [])[1] || '';
    } else {
      uri.host     = location.host;
      uri.hostname = location.hostname;
      uri.port     = location.port;
    }

    uri.pathname = uri.pathname || '/';
    uri.path = uri.pathname + uri.search;

    query = uri.search.replace(/^\?/, '');
    pairs = query ? query.split('&') : [];
    data  = {};

    for (i = 0, n = pairs.length; i < n; i++) {
      parts = pairs[i].split('=');
      data[decodeURIComponent(parts[0] || '')] = decodeURIComponent(parts[1] || '');
    }

    uri.query = data;

    uri.href = this.stringify(uri);
    return uri;
  },

  stringify: function(uri) {
    var auth   = uri.auth ? uri.auth + '@' : '',
        string = uri.protocol + '//' + auth + uri.host;

    string += uri.pathname + this.queryString(uri.query) + (uri.hash || '');

    return string;
  },

  queryString: function(query) {
    var pairs = [];
    for (var key in query) {
      if (!query.hasOwnProperty(key)) continue;
      pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(query[key]));
    }
    if (pairs.length === 0) return '';
    return '?' + pairs.join('&');
  }
};

},{}],38:[function(require,module,exports){
'use strict';

var array = require('./array');

module.exports = function(options, validKeys) {
  for (var key in options) {
    if (array.indexOf(validKeys, key) < 0)
      throw new Error('Unrecognized option: ' + key);
  }
};

},{"./array":26}],39:[function(require,module,exports){
(function (global){
'use strict';

var WS = global.MozWebSocket || global.WebSocket;

module.exports = {
  create: function(url, protocols, options) {
    if (typeof WS !== 'function') return null;
    return new WS(url);
  }
};

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],40:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}]},{},[2])(2)
});

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJsaWIvYXBpL3N0cmVhbWluZy1leHRlbnNpb24uanMiLCJsaWIvYXBpL3N0cmVhbWluZy5qcyIsIm5vZGVfbW9kdWxlcy9hc2FwL2Jyb3dzZXItYXNhcC5qcyIsIm5vZGVfbW9kdWxlcy9hc2FwL2Jyb3dzZXItcmF3LmpzIiwibm9kZV9tb2R1bGVzL2ZheWUvc3JjL2ZheWVfYnJvd3Nlci5qcyIsIm5vZGVfbW9kdWxlcy9mYXllL3NyYy9taXhpbnMvZGVmZXJyYWJsZS5qcyIsIm5vZGVfbW9kdWxlcy9mYXllL3NyYy9taXhpbnMvbG9nZ2luZy5qcyIsIm5vZGVfbW9kdWxlcy9mYXllL3NyYy9taXhpbnMvcHVibGlzaGVyLmpzIiwibm9kZV9tb2R1bGVzL2ZheWUvc3JjL21peGlucy90aW1lb3V0cy5qcyIsIm5vZGVfbW9kdWxlcy9mYXllL3NyYy9wcm90b2NvbC9jaGFubmVsLmpzIiwibm9kZV9tb2R1bGVzL2ZheWUvc3JjL3Byb3RvY29sL2NsaWVudC5qcyIsIm5vZGVfbW9kdWxlcy9mYXllL3NyYy9wcm90b2NvbC9kaXNwYXRjaGVyLmpzIiwibm9kZV9tb2R1bGVzL2ZheWUvc3JjL3Byb3RvY29sL2Vycm9yLmpzIiwibm9kZV9tb2R1bGVzL2ZheWUvc3JjL3Byb3RvY29sL2V4dGVuc2libGUuanMiLCJub2RlX21vZHVsZXMvZmF5ZS9zcmMvcHJvdG9jb2wvZ3JhbW1hci5qcyIsIm5vZGVfbW9kdWxlcy9mYXllL3NyYy9wcm90b2NvbC9wdWJsaWNhdGlvbi5qcyIsIm5vZGVfbW9kdWxlcy9mYXllL3NyYy9wcm90b2NvbC9zY2hlZHVsZXIuanMiLCJub2RlX21vZHVsZXMvZmF5ZS9zcmMvcHJvdG9jb2wvc3Vic2NyaXB0aW9uLmpzIiwibm9kZV9tb2R1bGVzL2ZheWUvc3JjL3RyYW5zcG9ydC9icm93c2VyX3RyYW5zcG9ydHMuanMiLCJub2RlX21vZHVsZXMvZmF5ZS9zcmMvdHJhbnNwb3J0L2NvcnMuanMiLCJub2RlX21vZHVsZXMvZmF5ZS9zcmMvdHJhbnNwb3J0L2V2ZW50X3NvdXJjZS5qcyIsIm5vZGVfbW9kdWxlcy9mYXllL3NyYy90cmFuc3BvcnQvanNvbnAuanMiLCJub2RlX21vZHVsZXMvZmF5ZS9zcmMvdHJhbnNwb3J0L3RyYW5zcG9ydC5qcyIsIm5vZGVfbW9kdWxlcy9mYXllL3NyYy90cmFuc3BvcnQvd2ViX3NvY2tldC5qcyIsIm5vZGVfbW9kdWxlcy9mYXllL3NyYy90cmFuc3BvcnQveGhyLmpzIiwibm9kZV9tb2R1bGVzL2ZheWUvc3JjL3V0aWwvYXJyYXkuanMiLCJub2RlX21vZHVsZXMvZmF5ZS9zcmMvdXRpbC9hc3NpZ24uanMiLCJub2RlX21vZHVsZXMvZmF5ZS9zcmMvdXRpbC9icm93c2VyL2V2ZW50LmpzIiwibm9kZV9tb2R1bGVzL2ZheWUvc3JjL3V0aWwvY2xhc3MuanMiLCJub2RlX21vZHVsZXMvZmF5ZS9zcmMvdXRpbC9jb25zdGFudHMuanMiLCJub2RlX21vZHVsZXMvZmF5ZS9zcmMvdXRpbC9jb29raWVzL2Jyb3dzZXJfY29va2llcy5qcyIsIm5vZGVfbW9kdWxlcy9mYXllL3NyYy91dGlsL2NvcHlfb2JqZWN0LmpzIiwibm9kZV9tb2R1bGVzL2ZheWUvc3JjL3V0aWwvZXZlbnRfZW1pdHRlci5qcyIsIm5vZGVfbW9kdWxlcy9mYXllL3NyYy91dGlsL3Byb21pc2UuanMiLCJub2RlX21vZHVsZXMvZmF5ZS9zcmMvdXRpbC9zZXQuanMiLCJub2RlX21vZHVsZXMvZmF5ZS9zcmMvdXRpbC90b19qc29uLmpzIiwibm9kZV9tb2R1bGVzL2ZheWUvc3JjL3V0aWwvdXJpLmpzIiwibm9kZV9tb2R1bGVzL2ZheWUvc3JjL3V0aWwvdmFsaWRhdGVfb3B0aW9ucy5qcyIsIm5vZGVfbW9kdWxlcy9mYXllL3NyYy91dGlsL3dlYnNvY2tldC9icm93c2VyX3dlYnNvY2tldC5qcyIsIm5vZGVfbW9kdWxlcy9wcm9jZXNzL2Jyb3dzZXIuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hJQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5UUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ2xFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDL05BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUNmQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQ2hEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ3JDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUMxQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ3BJQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7OztBQ2pZQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQzFMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNSQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNOQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDWEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7QUNyRkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7QUNqR0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7QUNoRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7QUN6TkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7OztBQ2pLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDbEZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDaEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQ2xEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVkE7QUFDQTtBQUNBO0FBQ0E7O0FDSEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0tBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUtBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMUZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ1ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUNWQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24oKXtmdW5jdGlvbiByKGUsbix0KXtmdW5jdGlvbiBvKGksZil7aWYoIW5baV0pe2lmKCFlW2ldKXt2YXIgYz1cImZ1bmN0aW9uXCI9PXR5cGVvZiByZXF1aXJlJiZyZXF1aXJlO2lmKCFmJiZjKXJldHVybiBjKGksITApO2lmKHUpcmV0dXJuIHUoaSwhMCk7dmFyIGE9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitpK1wiJ1wiKTt0aHJvdyBhLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsYX12YXIgcD1uW2ldPXtleHBvcnRzOnt9fTtlW2ldWzBdLmNhbGwocC5leHBvcnRzLGZ1bmN0aW9uKHIpe3ZhciBuPWVbaV1bMV1bcl07cmV0dXJuIG8obnx8cil9LHAscC5leHBvcnRzLHIsZSxuLHQpfXJldHVybiBuW2ldLmV4cG9ydHN9Zm9yKHZhciB1PVwiZnVuY3Rpb25cIj09dHlwZW9mIHJlcXVpcmUmJnJlcXVpcmUsaT0wO2k8dC5sZW5ndGg7aSsrKW8odFtpXSk7cmV0dXJuIG99cmV0dXJuIHJ9KSgpIiwiLyoqXHJcbiAqIEZheWUgQ2xpZW50IGV4dGVuc2lvbnM6IGh0dHBzOi8vZmF5ZS5qY29nbGFuLmNvbS9icm93c2VyL2V4dGVuc2lvbnMuaHRtbFxyXG4gKlxyXG4gKiBGb3IgdXNlIHdpdGggU3RyZWFtaW5nLnByb3RvdHlwZS5jcmVhdGVDbGllbnQoKVxyXG4qKi9cclxudmFyIFN0cmVhbWluZ0V4dGVuc2lvbiA9IHt9O1xyXG5cclxuLyoqXHJcbiAqIENvbnN0cnVjdG9yIGZvciBhbiBhdXRoIGZhaWx1cmUgZGV0ZWN0b3IgZXh0ZW5zaW9uXHJcbiAqXHJcbiAqIEJhc2VkIG9uIG5ldyBmZWF0dXJlIHJlbGVhc2VkIHdpdGggU2FsZXNmb3JjZSBTcHJpbmcgJzE4OlxyXG4gKiBodHRwczovL3JlbGVhc2Vub3Rlcy5kb2NzLnNhbGVzZm9yY2UuY29tL2VuLXVzL3NwcmluZzE4L3JlbGVhc2Utbm90ZXMvcm5fbWVzc2FnaW5nX2NvbWV0ZF9hdXRoX3ZhbGlkYXRpb24uaHRtP2VkaXRpb249JmltcGFjdD1cclxuICpcclxuICogRXhhbXBsZSB0cmlnZ2VyaW5nIGVycm9yIG1lc3NhZ2U6XHJcbiAqXHJcbiAqIGBgYFxyXG4gKiB7XHJcbiAqICAgXCJleHRcIjp7XHJcbiAqICAgICBcInNmZGNcIjp7XCJmYWlsdXJlUmVhc29uXCI6XCI0MDE6OkF1dGhlbnRpY2F0aW9uIGludmFsaWRcIn0sXHJcbiAqICAgICBcInJlcGxheVwiOnRydWV9LFxyXG4gKiAgIFwiYWR2aWNlXCI6e1wicmVjb25uZWN0XCI6XCJub25lXCJ9LFxyXG4gKiAgIFwiY2hhbm5lbFwiOlwiL21ldGEvaGFuZHNoYWtlXCIsXHJcbiAqICAgXCJlcnJvclwiOlwiNDAzOjpIYW5kc2hha2UgZGVuaWVkXCIsXHJcbiAqICAgXCJzdWNjZXNzZnVsXCI6ZmFsc2VcclxuICogfVxyXG4gKiBgYGBcclxuICpcclxuICogRXhhbXBsZSB1c2FnZTpcclxuICpcclxuICogYGBgamF2YXNjcmlwdFxyXG4gKiBjb25zdCBjb25uID0gbmV3IGpzZm9yY2UuQ29ubmVjdGlvbih7IOKApiB9KTtcclxuICogXHJcbiAqIGNvbnN0IGNoYW5uZWwgPSBcIi9ldmVudC9NeV9FdmVudF9fZVwiO1xyXG4gKiBcclxuICogLy8gRXhpdCB0aGUgTm9kZSBwcm9jZXNzIHdoZW4gYXV0aCBmYWlsc1xyXG4gKiBjb25zdCBleGl0Q2FsbGJhY2sgPSAoKSA9PiBwcm9jZXNzLmV4aXQoMSk7XHJcbiAqIGNvbnN0IGF1dGhGYWlsdXJlRXh0ID0gbmV3IGpzZm9yY2UuU3RyZWFtaW5nRXh0ZW5zaW9uLkF1dGhGYWlsdXJlKGV4aXRDYWxsYmFjayk7XHJcbiAqIFxyXG4gKiBjb25zdCBmYXllQ2xpZW50ID0gY29ubi5zdHJlYW1pbmcuY3JlYXRlQ2xpZW50KFsgYXV0aEZhaWx1cmVFeHQgXSk7XHJcbiAqIFxyXG4gKiBjb25zdCBzdWJzY3JpcHRpb24gPSBmYXllQ2xpZW50LnN1YnNjcmliZShjaGFubmVsLCBkYXRhID0+IHtcclxuICogICBjb25zb2xlLmxvZygndG9waWMgcmVjZWl2ZWQgZGF0YScsIGRhdGEpO1xyXG4gKiB9KTtcclxuICogXHJcbiAqIHN1YnNjcmlwdGlvbi5jYW5jZWwoKTtcclxuICogYGBgXHJcbiAqXHJcbiAqIEBwYXJhbSB7RnVuY3Rpb259IGZhaWx1cmVDYWxsYmFjayAtIEludm9rZWQgd2hlbiBhdXRoZW50aWNhdGlvbiBiZWNvbWVzIGludmFsaWRcclxuICovXHJcblN0cmVhbWluZ0V4dGVuc2lvbi5BdXRoRmFpbHVyZSA9IGZ1bmN0aW9uKGZhaWx1cmVDYWxsYmFjaykge1xyXG4gIHRoaXMuaW5jb21pbmcgPSBmdW5jdGlvbihtZXNzYWdlLCBjYWxsYmFjaykge1xyXG4gICAgaWYgKFxyXG4gICAgICAobWVzc2FnZS5jaGFubmVsID09PSAnL21ldGEvY29ubmVjdCcgfHxcclxuICAgICAgICBtZXNzYWdlLmNoYW5uZWwgPT09ICcvbWV0YS9oYW5kc2hha2UnKVxyXG4gICAgICAmJiBtZXNzYWdlLmFkdmljZVxyXG4gICAgICAmJiBtZXNzYWdlLmFkdmljZS5yZWNvbm5lY3QgPT0gJ25vbmUnXHJcbiAgICApIHtcclxuICAgICAgZmFpbHVyZUNhbGxiYWNrKG1lc3NhZ2UpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgY2FsbGJhY2sobWVzc2FnZSk7XHJcbiAgICB9XHJcbiAgfVxyXG59O1xyXG5cclxuLyoqXHJcbiAqIENvbnN0cnVjdG9yIGZvciBhIGR1cmFibGUgc3RyZWFtaW5nIHJlcGxheSBleHRlbnNpb25cclxuICpcclxuICogTW9kaWZpZWQgZnJvbSBvcmlnaW5hbCBTYWxlc2ZvcmNlIGRlbW8gc291cmNlIGNvZGU6XHJcbiAqIGh0dHBzOi8vZ2l0aHViLmNvbS9kZXZlbG9wZXJmb3JjZS9TYWxlc2ZvcmNlRHVyYWJsZVN0cmVhbWluZ0RlbW8vYmxvYi8zZDRhNTZlYWM5NTZmNzQ0YWQ2YzIyZTZhODE0MWI2ZmViNTdhYmI5L3N0YXRpY3Jlc291cmNlcy9jb21ldGRSZXBsYXlFeHRlbnNpb24ucmVzb3VyY2VcclxuICogXHJcbiAqIEV4YW1wbGUgdXNhZ2U6XHJcbiAqXHJcbiAqIGBgYGphdmFzY3JpcHRcclxuICogY29uc3QgY29ubiA9IG5ldyBqc2ZvcmNlLkNvbm5lY3Rpb24oeyDigKYgfSk7XHJcbiAqIFxyXG4gKiBjb25zdCBjaGFubmVsID0gXCIvZXZlbnQvTXlfRXZlbnRfX2VcIjtcclxuICogY29uc3QgcmVwbGF5SWQgPSAtMjsgLy8gLTIgaXMgYWxsIHJldGFpbmVkIGV2ZW50c1xyXG4gKiBcclxuICogY29uc3QgcmVwbGF5RXh0ID0gbmV3IGpzZm9yY2UuU3RyZWFtaW5nRXh0ZW5zaW9uLlJlcGxheShjaGFubmVsLCByZXBsYXlJZCk7XHJcbiAqIFxyXG4gKiBjb25zdCBmYXllQ2xpZW50ID0gY29ubi5zdHJlYW1pbmcuY3JlYXRlQ2xpZW50KFsgcmVwbGF5RXh0IF0pO1xyXG4gKiBcclxuICogY29uc3Qgc3Vic2NyaXB0aW9uID0gZmF5ZUNsaWVudC5zdWJzY3JpYmUoY2hhbm5lbCwgZGF0YSA9PiB7XHJcbiAqICAgY29uc29sZS5sb2coJ3RvcGljIHJlY2VpdmVkIGRhdGEnLCBkYXRhKTtcclxuICogfSk7XHJcbiAqIFxyXG4gKiBzdWJzY3JpcHRpb24uY2FuY2VsKCk7XHJcbiAqIGBgYFxyXG4gKi9cclxuU3RyZWFtaW5nRXh0ZW5zaW9uLlJlcGxheSA9IGZ1bmN0aW9uKGNoYW5uZWwsIHJlcGxheUlkKSB7XHJcbiAgdmFyIFJFUExBWV9GUk9NX0tFWSA9IFwicmVwbGF5XCI7XHJcbiAgXHJcbiAgdmFyIF9leHRlbnNpb25FbmFibGVkID0gcmVwbGF5SWQgIT0gbnVsbCA/IHRydWUgOiBmYWxzZTtcclxuICB2YXIgX3JlcGxheSA9IHJlcGxheUlkO1xyXG4gIHZhciBfY2hhbm5lbCA9IGNoYW5uZWw7XHJcblxyXG4gIHRoaXMuc2V0RXh0ZW5zaW9uRW5hYmxlZCA9IGZ1bmN0aW9uKGV4dGVuc2lvbkVuYWJsZWQpIHtcclxuICAgIF9leHRlbnNpb25FbmFibGVkID0gZXh0ZW5zaW9uRW5hYmxlZDtcclxuICB9XHJcblxyXG4gIHRoaXMuc2V0UmVwbGF5ID0gZnVuY3Rpb24gKHJlcGxheSkge1xyXG4gICAgX3JlcGxheSA9IHBhcnNlSW50KHJlcGxheSwgMTApO1xyXG4gIH1cclxuXHJcbiAgdGhpcy5zZXRDaGFubmVsID0gZnVuY3Rpb24oY2hhbm5lbCkge1xyXG4gICAgX2NoYW5uZWwgPSBjaGFubmVsO1xyXG4gIH1cclxuXHJcbiAgdGhpcy5pbmNvbWluZyA9IGZ1bmN0aW9uKG1lc3NhZ2UsIGNhbGxiYWNrKSB7XHJcbiAgICBpZiAobWVzc2FnZS5jaGFubmVsID09PSAnL21ldGEvaGFuZHNoYWtlJykge1xyXG4gICAgICBpZiAobWVzc2FnZS5leHQgJiYgbWVzc2FnZS5leHRbUkVQTEFZX0ZST01fS0VZXSA9PSB0cnVlKSB7XHJcbiAgICAgICAgX2V4dGVuc2lvbkVuYWJsZWQgPSB0cnVlO1xyXG4gICAgICB9XHJcbiAgICB9IGVsc2UgaWYgKG1lc3NhZ2UuY2hhbm5lbCA9PT0gX2NoYW5uZWwgJiYgbWVzc2FnZS5kYXRhICYmIG1lc3NhZ2UuZGF0YS5ldmVudCAmJiBtZXNzYWdlLmRhdGEuZXZlbnQucmVwbGF5SWQpIHtcclxuICAgICAgX3JlcGxheSA9IG1lc3NhZ2UuZGF0YS5ldmVudC5yZXBsYXlJZDtcclxuICAgIH1cclxuICAgIGNhbGxiYWNrKG1lc3NhZ2UpO1xyXG4gIH1cclxuICBcclxuICB0aGlzLm91dGdvaW5nID0gZnVuY3Rpb24obWVzc2FnZSwgY2FsbGJhY2spIHtcclxuICAgIGlmIChtZXNzYWdlLmNoYW5uZWwgPT09ICcvbWV0YS9zdWJzY3JpYmUnICYmIG1lc3NhZ2Uuc3Vic2NyaXB0aW9uID09PSBfY2hhbm5lbCkge1xyXG4gICAgICBpZiAoX2V4dGVuc2lvbkVuYWJsZWQpIHtcclxuICAgICAgICBpZiAoIW1lc3NhZ2UuZXh0KSB7IG1lc3NhZ2UuZXh0ID0ge307IH1cclxuXHJcbiAgICAgICAgdmFyIHJlcGxheUZyb21NYXAgPSB7fTtcclxuICAgICAgICByZXBsYXlGcm9tTWFwW19jaGFubmVsXSA9IF9yZXBsYXk7XHJcblxyXG4gICAgICAgIC8vIGFkZCBcImV4dCA6IHsgXCJyZXBsYXlcIiA6IHsgQ0hBTk5FTCA6IFJFUExBWV9WQUxVRSB9fVwiIHRvIHN1YnNjcmliZSBtZXNzYWdlXHJcbiAgICAgICAgbWVzc2FnZS5leHRbUkVQTEFZX0ZST01fS0VZXSA9IHJlcGxheUZyb21NYXA7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICAgIGNhbGxiYWNrKG1lc3NhZ2UpO1xyXG4gIH07XHJcbn07XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IFN0cmVhbWluZ0V4dGVuc2lvbjtcclxuIiwiLyoqXHJcbiAqIEBmaWxlIE1hbmFnZXMgU3RyZWFtaW5nIEFQSXNcclxuICogQGF1dGhvciBTaGluaWNoaSBUb21pdGEgPHNoaW5pY2hpLnRvbWl0YUBnbWFpbC5jb20+XHJcbiAqL1xyXG5cclxuJ3VzZSBzdHJpY3QnO1xyXG5cclxudmFyIGV2ZW50cyA9IHdpbmRvdy5qc2ZvcmNlLnJlcXVpcmUoJ2V2ZW50cycpLFxyXG4gICAgaW5oZXJpdHMgPSB3aW5kb3cuanNmb3JjZS5yZXF1aXJlKCdpbmhlcml0cycpLFxyXG4gICAgXyA9IHdpbmRvdy5qc2ZvcmNlLnJlcXVpcmUoJ2xvZGFzaC9jb3JlJyksXHJcbiAgICBGYXllICAgPSByZXF1aXJlKCdmYXllJyksXHJcbiAgICBTdHJlYW1pbmdFeHRlbnNpb24gPSByZXF1aXJlKCcuL3N0cmVhbWluZy1leHRlbnNpb24nKSxcclxuICAgIGpzZm9yY2UgPSB3aW5kb3cuanNmb3JjZS5yZXF1aXJlKCcuL2NvcmUnKTtcclxuXHJcbi8qKlxyXG4gKiBTdHJlYW1pbmcgQVBJIHRvcGljIGNsYXNzXHJcbiAqXHJcbiAqIEBjbGFzcyBTdHJlYW1pbmd+VG9waWNcclxuICogQHBhcmFtIHtTdHJlYW1pbmd9IHN0ZWFtaW5nIC0gU3RyZWFtaW5nIEFQSSBvYmplY3RcclxuICogQHBhcmFtIHtTdHJpbmd9IG5hbWUgLSBUb3BpYyBuYW1lXHJcbiAqL1xyXG52YXIgVG9waWMgPSBmdW5jdGlvbihzdHJlYW1pbmcsIG5hbWUpIHtcclxuICB0aGlzLl9zdHJlYW1pbmcgPSBzdHJlYW1pbmc7XHJcbiAgdGhpcy5uYW1lID0gbmFtZTtcclxufTtcclxuXHJcbi8qKlxyXG4gKiBAdHlwZWRlZiB7T2JqZWN0fSBTdHJlYW1pbmd+U3RyZWFtaW5nTWVzc2FnZVxyXG4gKiBAcHJvcCB7T2JqZWN0fSBldmVudFxyXG4gKiBAcHJvcCB7T2JqZWN0fSBldmVudC50eXBlIC0gRXZlbnQgdHlwZVxyXG4gKiBAcHJvcCB7UmVjb3JkfSBzb2JqZWN0IC0gUmVjb3JkIGluZm9ybWF0aW9uXHJcbiAqL1xyXG4vKipcclxuICogU3Vic2NyaWJlIGxpc3RlbmVyIHRvIHRvcGljXHJcbiAqXHJcbiAqIEBtZXRob2QgU3RyZWFtaW5nflRvcGljI3N1YnNjcmliZVxyXG4gKiBAcGFyYW0ge0NhbGxiYWNrLjxTdHJlYW1pbmd+U3RyZWFtaW5nTWVzYXNnZT59IGxpc3RlbmVyIC0gU3RyZWFtaW5nIG1lc3NhZ2UgbGlzdGVuZXJcclxuICogQHJldHVybnMge1N1YnNjcmlwdGlvbn0gLSBGYXllIHN1YnNjcmlwdGlvbiBvYmplY3RcclxuICovXHJcblRvcGljLnByb3RvdHlwZS5zdWJzY3JpYmUgPSBmdW5jdGlvbihsaXN0ZW5lcikge1xyXG4gIHJldHVybiB0aGlzLl9zdHJlYW1pbmcuc3Vic2NyaWJlKHRoaXMubmFtZSwgbGlzdGVuZXIpO1xyXG59O1xyXG5cclxuLyoqXHJcbiAqIFVuc3Vic2NyaWJlIGxpc3RlbmVyIGZyb20gdG9waWNcclxuICpcclxuICogQG1ldGhvZCBTdHJlYW1pbmd+VG9waWMjdW5zdWJzY3JpYmVcclxuICogQHBhcmFtIHtDYWxsYmFjay48U3RyZWFtaW5nflN0cmVhbWluZ01lc2FzZ2U+fSBsaXN0ZW5lciAtIFN0cmVhbWluZyBtZXNzYWdlIGxpc3RlbmVyXHJcbiAqIEByZXR1cm5zIHtTdHJlYW1pbmd+VG9waWN9XHJcbiAqL1xyXG5Ub3BpYy5wcm90b3R5cGUudW5zdWJzY3JpYmUgPSBmdW5jdGlvbihsaXN0ZW5lcikge1xyXG4gIHRoaXMuX3N0cmVhbWluZy51bnN1YnNjcmliZSh0aGlzLm5hbWUsIGxpc3RlbmVyKTtcclxuICByZXR1cm4gdGhpcztcclxufTtcclxuXHJcbi8qLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0qL1xyXG5cclxuLyoqXHJcbiAqIFN0cmVhbWluZyBBUEkgR2VuZXJpYyBTdHJlYW1pbmcgQ2hhbm5lbFxyXG4gKlxyXG4gKiBAY2xhc3MgU3RyZWFtaW5nfkNoYW5uZWxcclxuICogQHBhcmFtIHtTdHJlYW1pbmd9IHN0ZWFtaW5nIC0gU3RyZWFtaW5nIEFQSSBvYmplY3RcclxuICogQHBhcmFtIHtTdHJpbmd9IG5hbWUgLSBDaGFubmVsIG5hbWUgKHN0YXJ0cyB3aXRoIFwiL3UvXCIpXHJcbiAqL1xyXG52YXIgQ2hhbm5lbCA9IGZ1bmN0aW9uKHN0cmVhbWluZywgbmFtZSkge1xyXG4gIHRoaXMuX3N0cmVhbWluZyA9IHN0cmVhbWluZztcclxuICB0aGlzLl9uYW1lID0gbmFtZTtcclxufTtcclxuXHJcbi8qKlxyXG4gKiBTdWJzY3JpYmUgdG8gY2hhbm5lbFxyXG4gKlxyXG4gKiBAcGFyYW0ge0NhbGxiYWNrLjxTdHJlYW1pbmd+U3RyZWFtaW5nTWVzc2FnZT59IGxpc3RlbmVyIC0gU3RyZWFtaW5nIG1lc3NhZ2UgbGlzdGVuZXJcclxuICogQHJldHVybnMge1N1YnNjcmlwdGlvbn0gLSBGYXllIHN1YnNjcmlwdGlvbiBvYmplY3RcclxuICovXHJcbkNoYW5uZWwucHJvdG90eXBlLnN1YnNjcmliZSA9IGZ1bmN0aW9uKGxpc3RlbmVyKSB7XHJcbiAgcmV0dXJuIHRoaXMuX3N0cmVhbWluZy5zdWJzY3JpYmUodGhpcy5fbmFtZSwgbGlzdGVuZXIpO1xyXG59O1xyXG5cclxuQ2hhbm5lbC5wcm90b3R5cGUudW5zdWJzY3JpYmUgPSBmdW5jdGlvbihsaXN0ZW5lcikge1xyXG4gIHRoaXMuX3N0cmVhbWluZy51bnN1YnNjcmliZSh0aGlzLl9uYW1lLCBsaXN0ZW5lcik7XHJcbiAgcmV0dXJuIHRoaXM7XHJcbn07XHJcblxyXG5DaGFubmVsLnByb3RvdHlwZS5wdXNoID0gZnVuY3Rpb24oZXZlbnRzLCBjYWxsYmFjaykge1xyXG4gIHZhciBpc0FycmF5ID0gXy5pc0FycmF5KGV2ZW50cyk7XHJcbiAgZXZlbnRzID0gaXNBcnJheSA/IGV2ZW50cyA6IFsgZXZlbnRzIF07XHJcbiAgdmFyIGNvbm4gPSB0aGlzLl9zdHJlYW1pbmcuX2Nvbm47XHJcbiAgaWYgKCF0aGlzLl9pZCkge1xyXG4gICAgdGhpcy5faWQgPSBjb25uLnNvYmplY3QoJ1N0cmVhbWluZ0NoYW5uZWwnKS5maW5kT25lKHsgTmFtZTogdGhpcy5fbmFtZSB9LCAnSWQnKVxyXG4gICAgICAudGhlbihmdW5jdGlvbihyZWMpIHsgcmV0dXJuIHJlYy5JZCB9KTtcclxuICB9XHJcbiAgcmV0dXJuIHRoaXMuX2lkLnRoZW4oZnVuY3Rpb24oaWQpIHtcclxuICAgIHZhciBjaGFubmVsVXJsID0gJy9zb2JqZWN0cy9TdHJlYW1pbmdDaGFubmVsLycgKyBpZCArICcvcHVzaCc7XHJcbiAgICByZXR1cm4gY29ubi5yZXF1ZXN0UG9zdChjaGFubmVsVXJsLCB7IHB1c2hFdmVudHM6IGV2ZW50cyB9KTtcclxuICB9KS50aGVuKGZ1bmN0aW9uKHJldHMpIHtcclxuICAgIHJldHVybiBpc0FycmF5ID8gcmV0cyA6IHJldHNbMF07XHJcbiAgfSkudGhlbkNhbGwoY2FsbGJhY2spO1xyXG59O1xyXG5cclxuLyotLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSovXHJcblxyXG4vKipcclxuICogU3RyZWFtaW5nIEFQSSBjbGFzc1xyXG4gKlxyXG4gKiBAY2xhc3NcclxuICogQGV4dGVuZHMgZXZlbnRzLkV2ZW50RW1pdHRlclxyXG4gKiBAcGFyYW0ge0Nvbm5lY3Rpb259IGNvbm4gLSBDb25uZWN0aW9uIG9iamVjdFxyXG4gKi9cclxudmFyIFN0cmVhbWluZyA9IGZ1bmN0aW9uKGNvbm4pIHtcclxuICB0aGlzLl9jb25uID0gY29ubjtcclxufTtcclxuXHJcbmluaGVyaXRzKFN0cmVhbWluZywgZXZlbnRzLkV2ZW50RW1pdHRlcik7XHJcblxyXG4vKiogQHByaXZhdGUgKiovXHJcblN0cmVhbWluZy5wcm90b3R5cGUuX2NyZWF0ZUNsaWVudCA9IGZ1bmN0aW9uKGZvckNoYW5uZWxOYW1lLCBleHRlbnNpb25zKSB7XHJcbiAgLy8gZm9yQ2hhbm5lbE5hbWUgaXMgYWR2aXNvcnksIGZvciBhbiBBUEkgd29ya2Fyb3VuZC4gSXQgZG9lcyBub3QgcmVzdHJpY3Qgb3Igc2VsZWN0IHRoZSBjaGFubmVsLlxyXG4gIHZhciBuZWVkc1JlcGxheUZpeCA9IHR5cGVvZiBmb3JDaGFubmVsTmFtZSA9PT0gJ3N0cmluZycgJiYgZm9yQ2hhbm5lbE5hbWUuaW5kZXhPZignL3UvJykgPT09IDA7XHJcbiAgdmFyIGVuZHBvaW50VXJsID0gW1xyXG4gICAgdGhpcy5fY29ubi5pbnN0YW5jZVVybCxcclxuICAgIC8vIHNwZWNpYWwgZW5kcG9pbnQgXCIvY29tZXRkL3JlcGxheS94eC54XCIgaXMgb25seSBhdmFpbGFibGUgaW4gMzYuMC5cclxuICAgIC8vIFNlZSBodHRwczovL3JlbGVhc2Vub3Rlcy5kb2NzLnNhbGVzZm9yY2UuY29tL2VuLXVzL3N1bW1lcjE2L3JlbGVhc2Utbm90ZXMvcm5fYXBpX3N0cmVhbWluZ19jbGFzc2ljX3JlcGxheS5odG1cclxuICAgIFwiY29tZXRkXCIgKyAobmVlZHNSZXBsYXlGaXggPT09IHRydWUgJiYgdGhpcy5fY29ubi52ZXJzaW9uID09PSBcIjM2LjBcIiA/IFwiL3JlcGxheVwiIDogXCJcIiksXHJcbiAgICB0aGlzLl9jb25uLnZlcnNpb25cclxuICBdLmpvaW4oJy8nKTtcclxuICB2YXIgZmF5ZUNsaWVudCA9IG5ldyBGYXllLkNsaWVudChlbmRwb2ludFVybCwge30pO1xyXG4gIGZheWVDbGllbnQuc2V0SGVhZGVyKCdBdXRob3JpemF0aW9uJywgJ09BdXRoICcrdGhpcy5fY29ubi5hY2Nlc3NUb2tlbik7XHJcbiAgaWYgKGV4dGVuc2lvbnMgaW5zdGFuY2VvZiBBcnJheSkge1xyXG4gICAgZXh0ZW5zaW9ucy5mb3JFYWNoKGZ1bmN0aW9uKGV4dGVuc2lvbikge1xyXG4gICAgICBmYXllQ2xpZW50LmFkZEV4dGVuc2lvbihleHRlbnNpb24pO1xyXG4gICAgfSk7XHJcbiAgfVxyXG4gIGlmIChmYXllQ2xpZW50Ll9kaXNwYXRjaGVyLmdldENvbm5lY3Rpb25UeXBlcygpLmluZGV4T2YoJ2NhbGxiYWNrLXBvbGxpbmcnKSA9PT0gLTEpIHtcclxuICAgIC8vIHByZXZlbnQgc3RyZWFtaW5nIEFQSSBzZXJ2ZXIgZXJyb3JcclxuICAgIGZheWVDbGllbnQuX2Rpc3BhdGNoZXIuc2VsZWN0VHJhbnNwb3J0KCdsb25nLXBvbGxpbmcnKTtcclxuICAgIGZheWVDbGllbnQuX2Rpc3BhdGNoZXIuX3RyYW5zcG9ydC5iYXRjaGluZyA9IGZhbHNlO1xyXG4gIH1cclxuICByZXR1cm4gZmF5ZUNsaWVudDtcclxufTtcclxuXHJcbi8qKiBAcHJpdmF0ZSAqKi9cclxuU3RyZWFtaW5nLnByb3RvdHlwZS5fZ2V0RmF5ZUNsaWVudCA9IGZ1bmN0aW9uKGNoYW5uZWxOYW1lKSB7XHJcbiAgdmFyIGlzR2VuZXJpYyA9IGNoYW5uZWxOYW1lLmluZGV4T2YoJy91LycpID09PSAwO1xyXG4gIHZhciBjbGllbnRUeXBlID0gaXNHZW5lcmljID8gJ2dlbmVyaWMnIDogJ3B1c2hUb3BpYyc7XHJcbiAgaWYgKCF0aGlzLl9mYXllQ2xpZW50cyB8fCAhdGhpcy5fZmF5ZUNsaWVudHNbY2xpZW50VHlwZV0pIHtcclxuICAgIHRoaXMuX2ZheWVDbGllbnRzID0gdGhpcy5fZmF5ZUNsaWVudHMgfHwge307XHJcbiAgICB0aGlzLl9mYXllQ2xpZW50c1tjbGllbnRUeXBlXSA9IHRoaXMuX2NyZWF0ZUNsaWVudChjaGFubmVsTmFtZSk7XHJcbiAgfVxyXG4gIHJldHVybiB0aGlzLl9mYXllQ2xpZW50c1tjbGllbnRUeXBlXTtcclxufTtcclxuXHJcblxyXG4vKipcclxuICogR2V0IG5hbWVkIHRvcGljXHJcbiAqXHJcbiAqIEBwYXJhbSB7U3RyaW5nfSBuYW1lIC0gVG9waWMgbmFtZVxyXG4gKiBAcmV0dXJucyB7U3RyZWFtaW5nflRvcGljfVxyXG4gKi9cclxuU3RyZWFtaW5nLnByb3RvdHlwZS50b3BpYyA9IGZ1bmN0aW9uKG5hbWUpIHtcclxuICB0aGlzLl90b3BpY3MgPSB0aGlzLl90b3BpY3MgfHwge307XHJcbiAgdmFyIHRvcGljID0gdGhpcy5fdG9waWNzW25hbWVdID1cclxuICAgIHRoaXMuX3RvcGljc1tuYW1lXSB8fCBuZXcgVG9waWModGhpcywgbmFtZSk7XHJcbiAgcmV0dXJuIHRvcGljO1xyXG59O1xyXG5cclxuLyoqXHJcbiAqIEdldCBDaGFubmVsIGZvciBJZFxyXG4gKiBAcGFyYW0ge1N0cmluZ30gY2hhbm5lbElkIC0gSWQgb2YgU3RyZWFtaW5nQ2hhbm5lbCBvYmplY3RcclxuICogQHJldHVybnMge1N0cmVhbWluZ35DaGFubmVsfVxyXG4gKi9cclxuU3RyZWFtaW5nLnByb3RvdHlwZS5jaGFubmVsID0gZnVuY3Rpb24oY2hhbm5lbElkKSB7XHJcbiAgcmV0dXJuIG5ldyBDaGFubmVsKHRoaXMsIGNoYW5uZWxJZCk7XHJcbn07XHJcblxyXG4vKipcclxuICogU3Vic2NyaWJlIHRvcGljL2NoYW5uZWxcclxuICpcclxuICogQHBhcmFtIHtTdHJpbmd9IG5hbWUgLSBUb3BpYyBuYW1lXHJcbiAqIEBwYXJhbSB7Q2FsbGJhY2suPFN0cmVhbWluZ35TdHJlYW1pbmdNZXNzYWdlPn0gbGlzdGVuZXIgLSBTdHJlYW1pbmcgbWVzc2FnZSBsaXN0ZW5lclxyXG4gKiBAcmV0dXJucyB7U3Vic2NyaXB0aW9ufSAtIEZheWUgc3Vic2NyaXB0aW9uIG9iamVjdFxyXG4gKi9cclxuU3RyZWFtaW5nLnByb3RvdHlwZS5zdWJzY3JpYmUgPSBmdW5jdGlvbihuYW1lLCBsaXN0ZW5lcikge1xyXG4gIHZhciBjaGFubmVsTmFtZSA9IG5hbWUuaW5kZXhPZignLycpID09PSAwID8gbmFtZSA6ICcvdG9waWMvJyArIG5hbWU7XHJcbiAgdmFyIGZheWVDbGllbnQgPSB0aGlzLl9nZXRGYXllQ2xpZW50KGNoYW5uZWxOYW1lKTtcclxuICByZXR1cm4gZmF5ZUNsaWVudC5zdWJzY3JpYmUoY2hhbm5lbE5hbWUsIGxpc3RlbmVyKTtcclxufTtcclxuXHJcbi8qKlxyXG4gKiBVbnN1YnNjcmliZSB0b3BpY1xyXG4gKlxyXG4gKiBAcGFyYW0ge1N0cmluZ30gbmFtZSAtIFRvcGljIG5hbWVcclxuICogQHBhcmFtIHtDYWxsYmFjay48U3RyZWFtaW5nflN0cmVhbWluZ01lc3NhZ2U+fSBsaXN0ZW5lciAtIFN0cmVhbWluZyBtZXNzYWdlIGxpc3RlbmVyXHJcbiAqIEByZXR1cm5zIHtTdHJlYW1pbmd9XHJcbiAqL1xyXG5TdHJlYW1pbmcucHJvdG90eXBlLnVuc3Vic2NyaWJlID0gZnVuY3Rpb24obmFtZSwgbGlzdGVuZXIpIHtcclxuICB2YXIgY2hhbm5lbE5hbWUgPSBuYW1lLmluZGV4T2YoJy8nKSA9PT0gMCA/IG5hbWUgOiAnL3RvcGljLycgKyBuYW1lO1xyXG4gIHZhciBmYXllQ2xpZW50ID0gdGhpcy5fZ2V0RmF5ZUNsaWVudChjaGFubmVsTmFtZSk7XHJcbiAgZmF5ZUNsaWVudC51bnN1YnNjcmliZShjaGFubmVsTmFtZSwgbGlzdGVuZXIpO1xyXG4gIHJldHVybiB0aGlzO1xyXG59O1xyXG5cclxuXHJcbi8qKlxyXG4gKiBDcmVhdGUgYSBTdHJlYW1pbmcgY2xpZW50LCBvcHRpb25hbGx5IHdpdGggZXh0ZW5zaW9uc1xyXG4gKlxyXG4gKiBTZWUgRmF5ZSBkb2NzIGZvciBpbXBsZW1lbnRhdGlvbiBkZXRhaWxzOiBodHRwczovL2ZheWUuamNvZ2xhbi5jb20vYnJvd3Nlci9leHRlbnNpb25zLmh0bWxcclxuICpcclxuICogRXhhbXBsZSB1c2FnZTpcclxuICogXHJcbiAqIGBgYGphdmFzY3JpcHRcclxuICogLy8gRXN0YWJsaXNoIGEgU2FsZXNmb3JjZSBjb25uZWN0aW9uLiAoRGV0YWlscyBlbGlkZWQpXHJcbiAqIGNvbnN0IGNvbm4gPSBuZXcganNmb3JjZS5Db25uZWN0aW9uKHsg4oCmIH0pO1xyXG4gKiBcclxuICogY29uc3QgZmF5ZUNsaWVudCA9IGNvbm4uc3RyZWFtaW5nLmNyZWF0ZUNsaWVudCgpO1xyXG4gKiBcclxuICogY29uc3Qgc3Vic2NyaXB0aW9uID0gZmF5ZUNsaWVudC5zdWJzY3JpYmUoY2hhbm5lbCwgZGF0YSA9PiB7XHJcbiAqICAgY29uc29sZS5sb2coJ3RvcGljIHJlY2VpdmVkIGRhdGEnLCBkYXRhKTtcclxuICogfSk7XHJcbiAqIFxyXG4gKiBzdWJzY3JpcHRpb24uY2FuY2VsKCk7XHJcbiAqIGBgYFxyXG4gKiBcclxuICogRXhhbXBsZSB3aXRoIGV4dGVuc2lvbnMsIHVzaW5nIFJlcGxheSAmIEF1dGggRmFpbHVyZSBleHRlbnNpb25zIGluIGEgc2VydmVyLXNpZGUgTm9kZS5qcyBhcHA6XHJcbiAqIFxyXG4gKiBgYGBqYXZhc2NyaXB0XHJcbiAqIC8vIEVzdGFibGlzaCBhIFNhbGVzZm9yY2UgY29ubmVjdGlvbi4gKERldGFpbHMgZWxpZGVkKVxyXG4gKiBjb25zdCBjb25uID0gbmV3IGpzZm9yY2UuQ29ubmVjdGlvbih7IOKApiB9KTtcclxuICogXHJcbiAqIGNvbnN0IGNoYW5uZWwgPSBcIi9ldmVudC9NeV9FdmVudF9fZVwiO1xyXG4gKiBjb25zdCByZXBsYXlJZCA9IC0yOyAvLyAtMiBpcyBhbGwgcmV0YWluZWQgZXZlbnRzXHJcbiAqIFxyXG4gKiBjb25zdCBleGl0Q2FsbGJhY2sgPSAoKSA9PiBwcm9jZXNzLmV4aXQoMSk7XHJcbiAqIGNvbnN0IGF1dGhGYWlsdXJlRXh0ID0gbmV3IGpzZm9yY2UuU3RyZWFtaW5nRXh0ZW5zaW9uLkF1dGhGYWlsdXJlKGV4aXRDYWxsYmFjayk7XHJcbiAqIFxyXG4gKiBjb25zdCByZXBsYXlFeHQgPSBuZXcganNmb3JjZS5TdHJlYW1pbmdFeHRlbnNpb24uUmVwbGF5KGNoYW5uZWwsIHJlcGxheUlkKTtcclxuICogXHJcbiAqIGNvbnN0IGZheWVDbGllbnQgPSBjb25uLnN0cmVhbWluZy5jcmVhdGVDbGllbnQoW1xyXG4gKiAgIGF1dGhGYWlsdXJlRXh0LFxyXG4gKiAgIHJlcGxheUV4dFxyXG4gKiBdKTtcclxuICogXHJcbiAqIGNvbnN0IHN1YnNjcmlwdGlvbiA9IGZheWVDbGllbnQuc3Vic2NyaWJlKGNoYW5uZWwsIGRhdGEgPT4ge1xyXG4gKiAgIGNvbnNvbGUubG9nKCd0b3BpYyByZWNlaXZlZCBkYXRhJywgZGF0YSk7XHJcbiAqIH0pO1xyXG4gKiBcclxuICogc3Vic2NyaXB0aW9uLmNhbmNlbCgpO1xyXG4gKiBgYGBcclxuICogXHJcbiAqIEBwYXJhbSB7QXJyYXl9IEV4dGVuc2lvbnMgLSBPcHRpb25hbCwgZXh0ZW5zaW9ucyB0byBhcHBseSB0byB0aGUgRmF5ZSBjbGllbnRcclxuICogQHJldHVybnMge0ZheWVDbGllbnR9IC0gRmF5ZSBjbGllbnQgb2JqZWN0XHJcbiAqL1xyXG5TdHJlYW1pbmcucHJvdG90eXBlLmNyZWF0ZUNsaWVudCA9IGZ1bmN0aW9uKGV4dGVuc2lvbnMpIHtcclxuICByZXR1cm4gdGhpcy5fY3JlYXRlQ2xpZW50KG51bGwsIGV4dGVuc2lvbnMpO1xyXG59O1xyXG5cclxuLyotLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSovXHJcbi8qXHJcbiAqIFJlZ2lzdGVyIGhvb2sgaW4gY29ubmVjdGlvbiBpbnN0YW50aWF0aW9uIGZvciBkeW5hbWljYWxseSBhZGRpbmcgdGhpcyBBUEkgbW9kdWxlIGZlYXR1cmVzXHJcbiAqL1xyXG5qc2ZvcmNlLm9uKCdjb25uZWN0aW9uOm5ldycsIGZ1bmN0aW9uKGNvbm4pIHtcclxuICBjb25uLnN0cmVhbWluZyA9IG5ldyBTdHJlYW1pbmcoY29ubik7XHJcbn0pO1xyXG5cclxuLypcclxuICogXHJcbiAqL1xyXG5qc2ZvcmNlLlN0cmVhbWluZ0V4dGVuc2lvbiA9IFN0cmVhbWluZ0V4dGVuc2lvbjtcclxuXHJcbm1vZHVsZS5leHBvcnRzID0gU3RyZWFtaW5nO1xyXG4iLCJcInVzZSBzdHJpY3RcIjtcblxuLy8gcmF3QXNhcCBwcm92aWRlcyBldmVyeXRoaW5nIHdlIG5lZWQgZXhjZXB0IGV4Y2VwdGlvbiBtYW5hZ2VtZW50LlxudmFyIHJhd0FzYXAgPSByZXF1aXJlKFwiLi9yYXdcIik7XG4vLyBSYXdUYXNrcyBhcmUgcmVjeWNsZWQgdG8gcmVkdWNlIEdDIGNodXJuLlxudmFyIGZyZWVUYXNrcyA9IFtdO1xuLy8gV2UgcXVldWUgZXJyb3JzIHRvIGVuc3VyZSB0aGV5IGFyZSB0aHJvd24gaW4gcmlnaHQgb3JkZXIgKEZJRk8pLlxuLy8gQXJyYXktYXMtcXVldWUgaXMgZ29vZCBlbm91Z2ggaGVyZSwgc2luY2Ugd2UgYXJlIGp1c3QgZGVhbGluZyB3aXRoIGV4Y2VwdGlvbnMuXG52YXIgcGVuZGluZ0Vycm9ycyA9IFtdO1xudmFyIHJlcXVlc3RFcnJvclRocm93ID0gcmF3QXNhcC5tYWtlUmVxdWVzdENhbGxGcm9tVGltZXIodGhyb3dGaXJzdEVycm9yKTtcblxuZnVuY3Rpb24gdGhyb3dGaXJzdEVycm9yKCkge1xuICAgIGlmIChwZW5kaW5nRXJyb3JzLmxlbmd0aCkge1xuICAgICAgICB0aHJvdyBwZW5kaW5nRXJyb3JzLnNoaWZ0KCk7XG4gICAgfVxufVxuXG4vKipcbiAqIENhbGxzIGEgdGFzayBhcyBzb29uIGFzIHBvc3NpYmxlIGFmdGVyIHJldHVybmluZywgaW4gaXRzIG93biBldmVudCwgd2l0aCBwcmlvcml0eVxuICogb3ZlciBvdGhlciBldmVudHMgbGlrZSBhbmltYXRpb24sIHJlZmxvdywgYW5kIHJlcGFpbnQuIEFuIGVycm9yIHRocm93biBmcm9tIGFuXG4gKiBldmVudCB3aWxsIG5vdCBpbnRlcnJ1cHQsIG5vciBldmVuIHN1YnN0YW50aWFsbHkgc2xvdyBkb3duIHRoZSBwcm9jZXNzaW5nIG9mXG4gKiBvdGhlciBldmVudHMsIGJ1dCB3aWxsIGJlIHJhdGhlciBwb3N0cG9uZWQgdG8gYSBsb3dlciBwcmlvcml0eSBldmVudC5cbiAqIEBwYXJhbSB7e2NhbGx9fSB0YXNrIEEgY2FsbGFibGUgb2JqZWN0LCB0eXBpY2FsbHkgYSBmdW5jdGlvbiB0aGF0IHRha2VzIG5vXG4gKiBhcmd1bWVudHMuXG4gKi9cbm1vZHVsZS5leHBvcnRzID0gYXNhcDtcbmZ1bmN0aW9uIGFzYXAodGFzaykge1xuICAgIHZhciByYXdUYXNrO1xuICAgIGlmIChmcmVlVGFza3MubGVuZ3RoKSB7XG4gICAgICAgIHJhd1Rhc2sgPSBmcmVlVGFza3MucG9wKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcmF3VGFzayA9IG5ldyBSYXdUYXNrKCk7XG4gICAgfVxuICAgIHJhd1Rhc2sudGFzayA9IHRhc2s7XG4gICAgcmF3QXNhcChyYXdUYXNrKTtcbn1cblxuLy8gV2Ugd3JhcCB0YXNrcyB3aXRoIHJlY3ljbGFibGUgdGFzayBvYmplY3RzLiAgQSB0YXNrIG9iamVjdCBpbXBsZW1lbnRzXG4vLyBgY2FsbGAsIGp1c3QgbGlrZSBhIGZ1bmN0aW9uLlxuZnVuY3Rpb24gUmF3VGFzaygpIHtcbiAgICB0aGlzLnRhc2sgPSBudWxsO1xufVxuXG4vLyBUaGUgc29sZSBwdXJwb3NlIG9mIHdyYXBwaW5nIHRoZSB0YXNrIGlzIHRvIGNhdGNoIHRoZSBleGNlcHRpb24gYW5kIHJlY3ljbGVcbi8vIHRoZSB0YXNrIG9iamVjdCBhZnRlciBpdHMgc2luZ2xlIHVzZS5cblJhd1Rhc2sucHJvdG90eXBlLmNhbGwgPSBmdW5jdGlvbiAoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgdGhpcy50YXNrLmNhbGwoKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBpZiAoYXNhcC5vbmVycm9yKSB7XG4gICAgICAgICAgICAvLyBUaGlzIGhvb2sgZXhpc3RzIHB1cmVseSBmb3IgdGVzdGluZyBwdXJwb3Nlcy5cbiAgICAgICAgICAgIC8vIEl0cyBuYW1lIHdpbGwgYmUgcGVyaW9kaWNhbGx5IHJhbmRvbWl6ZWQgdG8gYnJlYWsgYW55IGNvZGUgdGhhdFxuICAgICAgICAgICAgLy8gZGVwZW5kcyBvbiBpdHMgZXhpc3RlbmNlLlxuICAgICAgICAgICAgYXNhcC5vbmVycm9yKGVycm9yKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIEluIGEgd2ViIGJyb3dzZXIsIGV4Y2VwdGlvbnMgYXJlIG5vdCBmYXRhbC4gSG93ZXZlciwgdG8gYXZvaWRcbiAgICAgICAgICAgIC8vIHNsb3dpbmcgZG93biB0aGUgcXVldWUgb2YgcGVuZGluZyB0YXNrcywgd2UgcmV0aHJvdyB0aGUgZXJyb3IgaW4gYVxuICAgICAgICAgICAgLy8gbG93ZXIgcHJpb3JpdHkgdHVybi5cbiAgICAgICAgICAgIHBlbmRpbmdFcnJvcnMucHVzaChlcnJvcik7XG4gICAgICAgICAgICByZXF1ZXN0RXJyb3JUaHJvdygpO1xuICAgICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICAgdGhpcy50YXNrID0gbnVsbDtcbiAgICAgICAgZnJlZVRhc2tzW2ZyZWVUYXNrcy5sZW5ndGhdID0gdGhpcztcbiAgICB9XG59O1xuIiwiXCJ1c2Ugc3RyaWN0XCI7XG5cbi8vIFVzZSB0aGUgZmFzdGVzdCBtZWFucyBwb3NzaWJsZSB0byBleGVjdXRlIGEgdGFzayBpbiBpdHMgb3duIHR1cm4sIHdpdGhcbi8vIHByaW9yaXR5IG92ZXIgb3RoZXIgZXZlbnRzIGluY2x1ZGluZyBJTywgYW5pbWF0aW9uLCByZWZsb3csIGFuZCByZWRyYXdcbi8vIGV2ZW50cyBpbiBicm93c2Vycy5cbi8vXG4vLyBBbiBleGNlcHRpb24gdGhyb3duIGJ5IGEgdGFzayB3aWxsIHBlcm1hbmVudGx5IGludGVycnVwdCB0aGUgcHJvY2Vzc2luZyBvZlxuLy8gc3Vic2VxdWVudCB0YXNrcy4gVGhlIGhpZ2hlciBsZXZlbCBgYXNhcGAgZnVuY3Rpb24gZW5zdXJlcyB0aGF0IGlmIGFuXG4vLyBleGNlcHRpb24gaXMgdGhyb3duIGJ5IGEgdGFzaywgdGhhdCB0aGUgdGFzayBxdWV1ZSB3aWxsIGNvbnRpbnVlIGZsdXNoaW5nIGFzXG4vLyBzb29uIGFzIHBvc3NpYmxlLCBidXQgaWYgeW91IHVzZSBgcmF3QXNhcGAgZGlyZWN0bHksIHlvdSBhcmUgcmVzcG9uc2libGUgdG9cbi8vIGVpdGhlciBlbnN1cmUgdGhhdCBubyBleGNlcHRpb25zIGFyZSB0aHJvd24gZnJvbSB5b3VyIHRhc2ssIG9yIHRvIG1hbnVhbGx5XG4vLyBjYWxsIGByYXdBc2FwLnJlcXVlc3RGbHVzaGAgaWYgYW4gZXhjZXB0aW9uIGlzIHRocm93bi5cbm1vZHVsZS5leHBvcnRzID0gcmF3QXNhcDtcbmZ1bmN0aW9uIHJhd0FzYXAodGFzaykge1xuICAgIGlmICghcXVldWUubGVuZ3RoKSB7XG4gICAgICAgIHJlcXVlc3RGbHVzaCgpO1xuICAgICAgICBmbHVzaGluZyA9IHRydWU7XG4gICAgfVxuICAgIC8vIEVxdWl2YWxlbnQgdG8gcHVzaCwgYnV0IGF2b2lkcyBhIGZ1bmN0aW9uIGNhbGwuXG4gICAgcXVldWVbcXVldWUubGVuZ3RoXSA9IHRhc2s7XG59XG5cbnZhciBxdWV1ZSA9IFtdO1xuLy8gT25jZSBhIGZsdXNoIGhhcyBiZWVuIHJlcXVlc3RlZCwgbm8gZnVydGhlciBjYWxscyB0byBgcmVxdWVzdEZsdXNoYCBhcmVcbi8vIG5lY2Vzc2FyeSB1bnRpbCB0aGUgbmV4dCBgZmx1c2hgIGNvbXBsZXRlcy5cbnZhciBmbHVzaGluZyA9IGZhbHNlO1xuLy8gYHJlcXVlc3RGbHVzaGAgaXMgYW4gaW1wbGVtZW50YXRpb24tc3BlY2lmaWMgbWV0aG9kIHRoYXQgYXR0ZW1wdHMgdG8ga2lja1xuLy8gb2ZmIGEgYGZsdXNoYCBldmVudCBhcyBxdWlja2x5IGFzIHBvc3NpYmxlLiBgZmx1c2hgIHdpbGwgYXR0ZW1wdCB0byBleGhhdXN0XG4vLyB0aGUgZXZlbnQgcXVldWUgYmVmb3JlIHlpZWxkaW5nIHRvIHRoZSBicm93c2VyJ3Mgb3duIGV2ZW50IGxvb3AuXG52YXIgcmVxdWVzdEZsdXNoO1xuLy8gVGhlIHBvc2l0aW9uIG9mIHRoZSBuZXh0IHRhc2sgdG8gZXhlY3V0ZSBpbiB0aGUgdGFzayBxdWV1ZS4gVGhpcyBpc1xuLy8gcHJlc2VydmVkIGJldHdlZW4gY2FsbHMgdG8gYGZsdXNoYCBzbyB0aGF0IGl0IGNhbiBiZSByZXN1bWVkIGlmXG4vLyBhIHRhc2sgdGhyb3dzIGFuIGV4Y2VwdGlvbi5cbnZhciBpbmRleCA9IDA7XG4vLyBJZiBhIHRhc2sgc2NoZWR1bGVzIGFkZGl0aW9uYWwgdGFza3MgcmVjdXJzaXZlbHksIHRoZSB0YXNrIHF1ZXVlIGNhbiBncm93XG4vLyB1bmJvdW5kZWQuIFRvIHByZXZlbnQgbWVtb3J5IGV4aGF1c3Rpb24sIHRoZSB0YXNrIHF1ZXVlIHdpbGwgcGVyaW9kaWNhbGx5XG4vLyB0cnVuY2F0ZSBhbHJlYWR5LWNvbXBsZXRlZCB0YXNrcy5cbnZhciBjYXBhY2l0eSA9IDEwMjQ7XG5cbi8vIFRoZSBmbHVzaCBmdW5jdGlvbiBwcm9jZXNzZXMgYWxsIHRhc2tzIHRoYXQgaGF2ZSBiZWVuIHNjaGVkdWxlZCB3aXRoXG4vLyBgcmF3QXNhcGAgdW5sZXNzIGFuZCB1bnRpbCBvbmUgb2YgdGhvc2UgdGFza3MgdGhyb3dzIGFuIGV4Y2VwdGlvbi5cbi8vIElmIGEgdGFzayB0aHJvd3MgYW4gZXhjZXB0aW9uLCBgZmx1c2hgIGVuc3VyZXMgdGhhdCBpdHMgc3RhdGUgd2lsbCByZW1haW5cbi8vIGNvbnNpc3RlbnQgYW5kIHdpbGwgcmVzdW1lIHdoZXJlIGl0IGxlZnQgb2ZmIHdoZW4gY2FsbGVkIGFnYWluLlxuLy8gSG93ZXZlciwgYGZsdXNoYCBkb2VzIG5vdCBtYWtlIGFueSBhcnJhbmdlbWVudHMgdG8gYmUgY2FsbGVkIGFnYWluIGlmIGFuXG4vLyBleGNlcHRpb24gaXMgdGhyb3duLlxuZnVuY3Rpb24gZmx1c2goKSB7XG4gICAgd2hpbGUgKGluZGV4IDwgcXVldWUubGVuZ3RoKSB7XG4gICAgICAgIHZhciBjdXJyZW50SW5kZXggPSBpbmRleDtcbiAgICAgICAgLy8gQWR2YW5jZSB0aGUgaW5kZXggYmVmb3JlIGNhbGxpbmcgdGhlIHRhc2suIFRoaXMgZW5zdXJlcyB0aGF0IHdlIHdpbGxcbiAgICAgICAgLy8gYmVnaW4gZmx1c2hpbmcgb24gdGhlIG5leHQgdGFzayB0aGUgdGFzayB0aHJvd3MgYW4gZXJyb3IuXG4gICAgICAgIGluZGV4ID0gaW5kZXggKyAxO1xuICAgICAgICBxdWV1ZVtjdXJyZW50SW5kZXhdLmNhbGwoKTtcbiAgICAgICAgLy8gUHJldmVudCBsZWFraW5nIG1lbW9yeSBmb3IgbG9uZyBjaGFpbnMgb2YgcmVjdXJzaXZlIGNhbGxzIHRvIGBhc2FwYC5cbiAgICAgICAgLy8gSWYgd2UgY2FsbCBgYXNhcGAgd2l0aGluIHRhc2tzIHNjaGVkdWxlZCBieSBgYXNhcGAsIHRoZSBxdWV1ZSB3aWxsXG4gICAgICAgIC8vIGdyb3csIGJ1dCB0byBhdm9pZCBhbiBPKG4pIHdhbGsgZm9yIGV2ZXJ5IHRhc2sgd2UgZXhlY3V0ZSwgd2UgZG9uJ3RcbiAgICAgICAgLy8gc2hpZnQgdGFza3Mgb2ZmIHRoZSBxdWV1ZSBhZnRlciB0aGV5IGhhdmUgYmVlbiBleGVjdXRlZC5cbiAgICAgICAgLy8gSW5zdGVhZCwgd2UgcGVyaW9kaWNhbGx5IHNoaWZ0IDEwMjQgdGFza3Mgb2ZmIHRoZSBxdWV1ZS5cbiAgICAgICAgaWYgKGluZGV4ID4gY2FwYWNpdHkpIHtcbiAgICAgICAgICAgIC8vIE1hbnVhbGx5IHNoaWZ0IGFsbCB2YWx1ZXMgc3RhcnRpbmcgYXQgdGhlIGluZGV4IGJhY2sgdG8gdGhlXG4gICAgICAgICAgICAvLyBiZWdpbm5pbmcgb2YgdGhlIHF1ZXVlLlxuICAgICAgICAgICAgZm9yICh2YXIgc2NhbiA9IDAsIG5ld0xlbmd0aCA9IHF1ZXVlLmxlbmd0aCAtIGluZGV4OyBzY2FuIDwgbmV3TGVuZ3RoOyBzY2FuKyspIHtcbiAgICAgICAgICAgICAgICBxdWV1ZVtzY2FuXSA9IHF1ZXVlW3NjYW4gKyBpbmRleF07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBxdWV1ZS5sZW5ndGggLT0gaW5kZXg7XG4gICAgICAgICAgICBpbmRleCA9IDA7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcXVldWUubGVuZ3RoID0gMDtcbiAgICBpbmRleCA9IDA7XG4gICAgZmx1c2hpbmcgPSBmYWxzZTtcbn1cblxuLy8gYHJlcXVlc3RGbHVzaGAgaXMgaW1wbGVtZW50ZWQgdXNpbmcgYSBzdHJhdGVneSBiYXNlZCBvbiBkYXRhIGNvbGxlY3RlZCBmcm9tXG4vLyBldmVyeSBhdmFpbGFibGUgU2F1Y2VMYWJzIFNlbGVuaXVtIHdlYiBkcml2ZXIgd29ya2VyIGF0IHRpbWUgb2Ygd3JpdGluZy5cbi8vIGh0dHBzOi8vZG9jcy5nb29nbGUuY29tL3NwcmVhZHNoZWV0cy9kLzFtRy01VVlHdXA1cXhHZEVNV2toUDZCV0N6MDUzTlViMkUxUW9VVFUxNnVBL2VkaXQjZ2lkPTc4MzcyNDU5M1xuXG4vLyBTYWZhcmkgNiBhbmQgNi4xIGZvciBkZXNrdG9wLCBpUGFkLCBhbmQgaVBob25lIGFyZSB0aGUgb25seSBicm93c2VycyB0aGF0XG4vLyBoYXZlIFdlYktpdE11dGF0aW9uT2JzZXJ2ZXIgYnV0IG5vdCB1bi1wcmVmaXhlZCBNdXRhdGlvbk9ic2VydmVyLlxuLy8gTXVzdCB1c2UgYGdsb2JhbGAgb3IgYHNlbGZgIGluc3RlYWQgb2YgYHdpbmRvd2AgdG8gd29yayBpbiBib3RoIGZyYW1lcyBhbmQgd2ViXG4vLyB3b3JrZXJzLiBgZ2xvYmFsYCBpcyBhIHByb3Zpc2lvbiBvZiBCcm93c2VyaWZ5LCBNciwgTXJzLCBvciBNb3AuXG5cbi8qIGdsb2JhbHMgc2VsZiAqL1xudmFyIHNjb3BlID0gdHlwZW9mIGdsb2JhbCAhPT0gXCJ1bmRlZmluZWRcIiA/IGdsb2JhbCA6IHNlbGY7XG52YXIgQnJvd3Nlck11dGF0aW9uT2JzZXJ2ZXIgPSBzY29wZS5NdXRhdGlvbk9ic2VydmVyIHx8IHNjb3BlLldlYktpdE11dGF0aW9uT2JzZXJ2ZXI7XG5cbi8vIE11dGF0aW9uT2JzZXJ2ZXJzIGFyZSBkZXNpcmFibGUgYmVjYXVzZSB0aGV5IGhhdmUgaGlnaCBwcmlvcml0eSBhbmQgd29ya1xuLy8gcmVsaWFibHkgZXZlcnl3aGVyZSB0aGV5IGFyZSBpbXBsZW1lbnRlZC5cbi8vIFRoZXkgYXJlIGltcGxlbWVudGVkIGluIGFsbCBtb2Rlcm4gYnJvd3NlcnMuXG4vL1xuLy8gLSBBbmRyb2lkIDQtNC4zXG4vLyAtIENocm9tZSAyNi0zNFxuLy8gLSBGaXJlZm94IDE0LTI5XG4vLyAtIEludGVybmV0IEV4cGxvcmVyIDExXG4vLyAtIGlQYWQgU2FmYXJpIDYtNy4xXG4vLyAtIGlQaG9uZSBTYWZhcmkgNy03LjFcbi8vIC0gU2FmYXJpIDYtN1xuaWYgKHR5cGVvZiBCcm93c2VyTXV0YXRpb25PYnNlcnZlciA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgcmVxdWVzdEZsdXNoID0gbWFrZVJlcXVlc3RDYWxsRnJvbU11dGF0aW9uT2JzZXJ2ZXIoZmx1c2gpO1xuXG4vLyBNZXNzYWdlQ2hhbm5lbHMgYXJlIGRlc2lyYWJsZSBiZWNhdXNlIHRoZXkgZ2l2ZSBkaXJlY3QgYWNjZXNzIHRvIHRoZSBIVE1MXG4vLyB0YXNrIHF1ZXVlLCBhcmUgaW1wbGVtZW50ZWQgaW4gSW50ZXJuZXQgRXhwbG9yZXIgMTAsIFNhZmFyaSA1LjAtMSwgYW5kIE9wZXJhXG4vLyAxMS0xMiwgYW5kIGluIHdlYiB3b3JrZXJzIGluIG1hbnkgZW5naW5lcy5cbi8vIEFsdGhvdWdoIG1lc3NhZ2UgY2hhbm5lbHMgeWllbGQgdG8gYW55IHF1ZXVlZCByZW5kZXJpbmcgYW5kIElPIHRhc2tzLCB0aGV5XG4vLyB3b3VsZCBiZSBiZXR0ZXIgdGhhbiBpbXBvc2luZyB0aGUgNG1zIGRlbGF5IG9mIHRpbWVycy5cbi8vIEhvd2V2ZXIsIHRoZXkgZG8gbm90IHdvcmsgcmVsaWFibHkgaW4gSW50ZXJuZXQgRXhwbG9yZXIgb3IgU2FmYXJpLlxuXG4vLyBJbnRlcm5ldCBFeHBsb3JlciAxMCBpcyB0aGUgb25seSBicm93c2VyIHRoYXQgaGFzIHNldEltbWVkaWF0ZSBidXQgZG9lc1xuLy8gbm90IGhhdmUgTXV0YXRpb25PYnNlcnZlcnMuXG4vLyBBbHRob3VnaCBzZXRJbW1lZGlhdGUgeWllbGRzIHRvIHRoZSBicm93c2VyJ3MgcmVuZGVyZXIsIGl0IHdvdWxkIGJlXG4vLyBwcmVmZXJyYWJsZSB0byBmYWxsaW5nIGJhY2sgdG8gc2V0VGltZW91dCBzaW5jZSBpdCBkb2VzIG5vdCBoYXZlXG4vLyB0aGUgbWluaW11bSA0bXMgcGVuYWx0eS5cbi8vIFVuZm9ydHVuYXRlbHkgdGhlcmUgYXBwZWFycyB0byBiZSBhIGJ1ZyBpbiBJbnRlcm5ldCBFeHBsb3JlciAxMCBNb2JpbGUgKGFuZFxuLy8gRGVza3RvcCB0byBhIGxlc3NlciBleHRlbnQpIHRoYXQgcmVuZGVycyBib3RoIHNldEltbWVkaWF0ZSBhbmRcbi8vIE1lc3NhZ2VDaGFubmVsIHVzZWxlc3MgZm9yIHRoZSBwdXJwb3NlcyBvZiBBU0FQLlxuLy8gaHR0cHM6Ly9naXRodWIuY29tL2tyaXNrb3dhbC9xL2lzc3Vlcy8zOTZcblxuLy8gVGltZXJzIGFyZSBpbXBsZW1lbnRlZCB1bml2ZXJzYWxseS5cbi8vIFdlIGZhbGwgYmFjayB0byB0aW1lcnMgaW4gd29ya2VycyBpbiBtb3N0IGVuZ2luZXMsIGFuZCBpbiBmb3JlZ3JvdW5kXG4vLyBjb250ZXh0cyBpbiB0aGUgZm9sbG93aW5nIGJyb3dzZXJzLlxuLy8gSG93ZXZlciwgbm90ZSB0aGF0IGV2ZW4gdGhpcyBzaW1wbGUgY2FzZSByZXF1aXJlcyBudWFuY2VzIHRvIG9wZXJhdGUgaW4gYVxuLy8gYnJvYWQgc3BlY3RydW0gb2YgYnJvd3NlcnMuXG4vL1xuLy8gLSBGaXJlZm94IDMtMTNcbi8vIC0gSW50ZXJuZXQgRXhwbG9yZXIgNi05XG4vLyAtIGlQYWQgU2FmYXJpIDQuM1xuLy8gLSBMeW54IDIuOC43XG59IGVsc2Uge1xuICAgIHJlcXVlc3RGbHVzaCA9IG1ha2VSZXF1ZXN0Q2FsbEZyb21UaW1lcihmbHVzaCk7XG59XG5cbi8vIGByZXF1ZXN0Rmx1c2hgIHJlcXVlc3RzIHRoYXQgdGhlIGhpZ2ggcHJpb3JpdHkgZXZlbnQgcXVldWUgYmUgZmx1c2hlZCBhc1xuLy8gc29vbiBhcyBwb3NzaWJsZS5cbi8vIFRoaXMgaXMgdXNlZnVsIHRvIHByZXZlbnQgYW4gZXJyb3IgdGhyb3duIGluIGEgdGFzayBmcm9tIHN0YWxsaW5nIHRoZSBldmVudFxuLy8gcXVldWUgaWYgdGhlIGV4Y2VwdGlvbiBoYW5kbGVkIGJ5IE5vZGUuanPigJlzXG4vLyBgcHJvY2Vzcy5vbihcInVuY2F1Z2h0RXhjZXB0aW9uXCIpYCBvciBieSBhIGRvbWFpbi5cbnJhd0FzYXAucmVxdWVzdEZsdXNoID0gcmVxdWVzdEZsdXNoO1xuXG4vLyBUbyByZXF1ZXN0IGEgaGlnaCBwcmlvcml0eSBldmVudCwgd2UgaW5kdWNlIGEgbXV0YXRpb24gb2JzZXJ2ZXIgYnkgdG9nZ2xpbmdcbi8vIHRoZSB0ZXh0IG9mIGEgdGV4dCBub2RlIGJldHdlZW4gXCIxXCIgYW5kIFwiLTFcIi5cbmZ1bmN0aW9uIG1ha2VSZXF1ZXN0Q2FsbEZyb21NdXRhdGlvbk9ic2VydmVyKGNhbGxiYWNrKSB7XG4gICAgdmFyIHRvZ2dsZSA9IDE7XG4gICAgdmFyIG9ic2VydmVyID0gbmV3IEJyb3dzZXJNdXRhdGlvbk9ic2VydmVyKGNhbGxiYWNrKTtcbiAgICB2YXIgbm9kZSA9IGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKFwiXCIpO1xuICAgIG9ic2VydmVyLm9ic2VydmUobm9kZSwge2NoYXJhY3RlckRhdGE6IHRydWV9KTtcbiAgICByZXR1cm4gZnVuY3Rpb24gcmVxdWVzdENhbGwoKSB7XG4gICAgICAgIHRvZ2dsZSA9IC10b2dnbGU7XG4gICAgICAgIG5vZGUuZGF0YSA9IHRvZ2dsZTtcbiAgICB9O1xufVxuXG4vLyBUaGUgbWVzc2FnZSBjaGFubmVsIHRlY2huaXF1ZSB3YXMgZGlzY292ZXJlZCBieSBNYWx0ZSBVYmwgYW5kIHdhcyB0aGVcbi8vIG9yaWdpbmFsIGZvdW5kYXRpb24gZm9yIHRoaXMgbGlicmFyeS5cbi8vIGh0dHA6Ly93d3cubm9uYmxvY2tpbmcuaW8vMjAxMS8wNi93aW5kb3duZXh0dGljay5odG1sXG5cbi8vIFNhZmFyaSA2LjAuNSAoYXQgbGVhc3QpIGludGVybWl0dGVudGx5IGZhaWxzIHRvIGNyZWF0ZSBtZXNzYWdlIHBvcnRzIG9uIGFcbi8vIHBhZ2UncyBmaXJzdCBsb2FkLiBUaGFua2Z1bGx5LCB0aGlzIHZlcnNpb24gb2YgU2FmYXJpIHN1cHBvcnRzXG4vLyBNdXRhdGlvbk9ic2VydmVycywgc28gd2UgZG9uJ3QgbmVlZCB0byBmYWxsIGJhY2sgaW4gdGhhdCBjYXNlLlxuXG4vLyBmdW5jdGlvbiBtYWtlUmVxdWVzdENhbGxGcm9tTWVzc2FnZUNoYW5uZWwoY2FsbGJhY2spIHtcbi8vICAgICB2YXIgY2hhbm5lbCA9IG5ldyBNZXNzYWdlQ2hhbm5lbCgpO1xuLy8gICAgIGNoYW5uZWwucG9ydDEub25tZXNzYWdlID0gY2FsbGJhY2s7XG4vLyAgICAgcmV0dXJuIGZ1bmN0aW9uIHJlcXVlc3RDYWxsKCkge1xuLy8gICAgICAgICBjaGFubmVsLnBvcnQyLnBvc3RNZXNzYWdlKDApO1xuLy8gICAgIH07XG4vLyB9XG5cbi8vIEZvciByZWFzb25zIGV4cGxhaW5lZCBhYm92ZSwgd2UgYXJlIGFsc28gdW5hYmxlIHRvIHVzZSBgc2V0SW1tZWRpYXRlYFxuLy8gdW5kZXIgYW55IGNpcmN1bXN0YW5jZXMuXG4vLyBFdmVuIGlmIHdlIHdlcmUsIHRoZXJlIGlzIGFub3RoZXIgYnVnIGluIEludGVybmV0IEV4cGxvcmVyIDEwLlxuLy8gSXQgaXMgbm90IHN1ZmZpY2llbnQgdG8gYXNzaWduIGBzZXRJbW1lZGlhdGVgIHRvIGByZXF1ZXN0Rmx1c2hgIGJlY2F1c2Vcbi8vIGBzZXRJbW1lZGlhdGVgIG11c3QgYmUgY2FsbGVkICpieSBuYW1lKiBhbmQgdGhlcmVmb3JlIG11c3QgYmUgd3JhcHBlZCBpbiBhXG4vLyBjbG9zdXJlLlxuLy8gTmV2ZXIgZm9yZ2V0LlxuXG4vLyBmdW5jdGlvbiBtYWtlUmVxdWVzdENhbGxGcm9tU2V0SW1tZWRpYXRlKGNhbGxiYWNrKSB7XG4vLyAgICAgcmV0dXJuIGZ1bmN0aW9uIHJlcXVlc3RDYWxsKCkge1xuLy8gICAgICAgICBzZXRJbW1lZGlhdGUoY2FsbGJhY2spO1xuLy8gICAgIH07XG4vLyB9XG5cbi8vIFNhZmFyaSA2LjAgaGFzIGEgcHJvYmxlbSB3aGVyZSB0aW1lcnMgd2lsbCBnZXQgbG9zdCB3aGlsZSB0aGUgdXNlciBpc1xuLy8gc2Nyb2xsaW5nLiBUaGlzIHByb2JsZW0gZG9lcyBub3QgaW1wYWN0IEFTQVAgYmVjYXVzZSBTYWZhcmkgNi4wIHN1cHBvcnRzXG4vLyBtdXRhdGlvbiBvYnNlcnZlcnMsIHNvIHRoYXQgaW1wbGVtZW50YXRpb24gaXMgdXNlZCBpbnN0ZWFkLlxuLy8gSG93ZXZlciwgaWYgd2UgZXZlciBlbGVjdCB0byB1c2UgdGltZXJzIGluIFNhZmFyaSwgdGhlIHByZXZhbGVudCB3b3JrLWFyb3VuZFxuLy8gaXMgdG8gYWRkIGEgc2Nyb2xsIGV2ZW50IGxpc3RlbmVyIHRoYXQgY2FsbHMgZm9yIGEgZmx1c2guXG5cbi8vIGBzZXRUaW1lb3V0YCBkb2VzIG5vdCBjYWxsIHRoZSBwYXNzZWQgY2FsbGJhY2sgaWYgdGhlIGRlbGF5IGlzIGxlc3MgdGhhblxuLy8gYXBwcm94aW1hdGVseSA3IGluIHdlYiB3b3JrZXJzIGluIEZpcmVmb3ggOCB0aHJvdWdoIDE4LCBhbmQgc29tZXRpbWVzIG5vdFxuLy8gZXZlbiB0aGVuLlxuXG5mdW5jdGlvbiBtYWtlUmVxdWVzdENhbGxGcm9tVGltZXIoY2FsbGJhY2spIHtcbiAgICByZXR1cm4gZnVuY3Rpb24gcmVxdWVzdENhbGwoKSB7XG4gICAgICAgIC8vIFdlIGRpc3BhdGNoIGEgdGltZW91dCB3aXRoIGEgc3BlY2lmaWVkIGRlbGF5IG9mIDAgZm9yIGVuZ2luZXMgdGhhdFxuICAgICAgICAvLyBjYW4gcmVsaWFibHkgYWNjb21tb2RhdGUgdGhhdCByZXF1ZXN0LiBUaGlzIHdpbGwgdXN1YWxseSBiZSBzbmFwcGVkXG4gICAgICAgIC8vIHRvIGEgNCBtaWxpc2Vjb25kIGRlbGF5LCBidXQgb25jZSB3ZSdyZSBmbHVzaGluZywgdGhlcmUncyBubyBkZWxheVxuICAgICAgICAvLyBiZXR3ZWVuIGV2ZW50cy5cbiAgICAgICAgdmFyIHRpbWVvdXRIYW5kbGUgPSBzZXRUaW1lb3V0KGhhbmRsZVRpbWVyLCAwKTtcbiAgICAgICAgLy8gSG93ZXZlciwgc2luY2UgdGhpcyB0aW1lciBnZXRzIGZyZXF1ZW50bHkgZHJvcHBlZCBpbiBGaXJlZm94XG4gICAgICAgIC8vIHdvcmtlcnMsIHdlIGVubGlzdCBhbiBpbnRlcnZhbCBoYW5kbGUgdGhhdCB3aWxsIHRyeSB0byBmaXJlXG4gICAgICAgIC8vIGFuIGV2ZW50IDIwIHRpbWVzIHBlciBzZWNvbmQgdW50aWwgaXQgc3VjY2VlZHMuXG4gICAgICAgIHZhciBpbnRlcnZhbEhhbmRsZSA9IHNldEludGVydmFsKGhhbmRsZVRpbWVyLCA1MCk7XG5cbiAgICAgICAgZnVuY3Rpb24gaGFuZGxlVGltZXIoKSB7XG4gICAgICAgICAgICAvLyBXaGljaGV2ZXIgdGltZXIgc3VjY2VlZHMgd2lsbCBjYW5jZWwgYm90aCB0aW1lcnMgYW5kXG4gICAgICAgICAgICAvLyBleGVjdXRlIHRoZSBjYWxsYmFjay5cbiAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aW1lb3V0SGFuZGxlKTtcbiAgICAgICAgICAgIGNsZWFySW50ZXJ2YWwoaW50ZXJ2YWxIYW5kbGUpO1xuICAgICAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgICAgfVxuICAgIH07XG59XG5cbi8vIFRoaXMgaXMgZm9yIGBhc2FwLmpzYCBvbmx5LlxuLy8gSXRzIG5hbWUgd2lsbCBiZSBwZXJpb2RpY2FsbHkgcmFuZG9taXplZCB0byBicmVhayBhbnkgY29kZSB0aGF0IGRlcGVuZHMgb25cbi8vIGl0cyBleGlzdGVuY2UuXG5yYXdBc2FwLm1ha2VSZXF1ZXN0Q2FsbEZyb21UaW1lciA9IG1ha2VSZXF1ZXN0Q2FsbEZyb21UaW1lcjtcblxuLy8gQVNBUCB3YXMgb3JpZ2luYWxseSBhIG5leHRUaWNrIHNoaW0gaW5jbHVkZWQgaW4gUS4gVGhpcyB3YXMgZmFjdG9yZWQgb3V0XG4vLyBpbnRvIHRoaXMgQVNBUCBwYWNrYWdlLiBJdCB3YXMgbGF0ZXIgYWRhcHRlZCB0byBSU1ZQIHdoaWNoIG1hZGUgZnVydGhlclxuLy8gYW1lbmRtZW50cy4gVGhlc2UgZGVjaXNpb25zLCBwYXJ0aWN1bGFybHkgdG8gbWFyZ2luYWxpemUgTWVzc2FnZUNoYW5uZWwgYW5kXG4vLyB0byBjYXB0dXJlIHRoZSBNdXRhdGlvbk9ic2VydmVyIGltcGxlbWVudGF0aW9uIGluIGEgY2xvc3VyZSwgd2VyZSBpbnRlZ3JhdGVkXG4vLyBiYWNrIGludG8gQVNBUCBwcm9wZXIuXG4vLyBodHRwczovL2dpdGh1Yi5jb20vdGlsZGVpby9yc3ZwLmpzL2Jsb2IvY2RkZjcyMzI1NDZhOWNmODU4NTI0Yjc1Y2RlNmY5ZWRmNzI2MjBhNy9saWIvcnN2cC9hc2FwLmpzXG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBjb25zdGFudHMgPSByZXF1aXJlKCcuL3V0aWwvY29uc3RhbnRzJyksXG4gICAgTG9nZ2luZyAgID0gcmVxdWlyZSgnLi9taXhpbnMvbG9nZ2luZycpO1xuXG52YXIgRmF5ZSA9IHtcbiAgVkVSU0lPTjogICAgY29uc3RhbnRzLlZFUlNJT04sXG5cbiAgQ2xpZW50OiAgICAgcmVxdWlyZSgnLi9wcm90b2NvbC9jbGllbnQnKSxcbiAgU2NoZWR1bGVyOiAgcmVxdWlyZSgnLi9wcm90b2NvbC9zY2hlZHVsZXInKVxufTtcblxuTG9nZ2luZy53cmFwcGVyID0gRmF5ZTtcblxubW9kdWxlLmV4cG9ydHMgPSBGYXllO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgUHJvbWlzZSAgID0gcmVxdWlyZSgnLi4vdXRpbC9wcm9taXNlJyk7XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICB0aGVuOiBmdW5jdGlvbihjYWxsYmFjaywgZXJyYmFjaykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoIXRoaXMuX3Byb21pc2UpXG4gICAgICB0aGlzLl9wcm9taXNlID0gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgICAgIHNlbGYuX3Jlc29sdmUgPSByZXNvbHZlO1xuICAgICAgICBzZWxmLl9yZWplY3QgID0gcmVqZWN0O1xuICAgICAgfSk7XG5cbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMClcbiAgICAgIHJldHVybiB0aGlzLl9wcm9taXNlO1xuICAgIGVsc2VcbiAgICAgIHJldHVybiB0aGlzLl9wcm9taXNlLnRoZW4oY2FsbGJhY2ssIGVycmJhY2spO1xuICB9LFxuXG4gIGNhbGxiYWNrOiBmdW5jdGlvbihjYWxsYmFjaywgY29udGV4dCkge1xuICAgIHJldHVybiB0aGlzLnRoZW4oZnVuY3Rpb24odmFsdWUpIHsgY2FsbGJhY2suY2FsbChjb250ZXh0LCB2YWx1ZSkgfSk7XG4gIH0sXG5cbiAgZXJyYmFjazogZnVuY3Rpb24oY2FsbGJhY2ssIGNvbnRleHQpIHtcbiAgICByZXR1cm4gdGhpcy50aGVuKG51bGwsIGZ1bmN0aW9uKHJlYXNvbikgeyBjYWxsYmFjay5jYWxsKGNvbnRleHQsIHJlYXNvbikgfSk7XG4gIH0sXG5cbiAgdGltZW91dDogZnVuY3Rpb24oc2Vjb25kcywgbWVzc2FnZSkge1xuICAgIHRoaXMudGhlbigpO1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICB0aGlzLl90aW1lciA9IGdsb2JhbC5zZXRUaW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgc2VsZi5fcmVqZWN0KG1lc3NhZ2UpO1xuICAgIH0sIHNlY29uZHMgKiAxMDAwKTtcbiAgfSxcblxuICBzZXREZWZlcnJlZFN0YXR1czogZnVuY3Rpb24oc3RhdHVzLCB2YWx1ZSkge1xuICAgIGlmICh0aGlzLl90aW1lcikgZ2xvYmFsLmNsZWFyVGltZW91dCh0aGlzLl90aW1lcik7XG5cbiAgICB0aGlzLnRoZW4oKTtcblxuICAgIGlmIChzdGF0dXMgPT09ICdzdWNjZWVkZWQnKVxuICAgICAgdGhpcy5fcmVzb2x2ZSh2YWx1ZSk7XG4gICAgZWxzZSBpZiAoc3RhdHVzID09PSAnZmFpbGVkJylcbiAgICAgIHRoaXMuX3JlamVjdCh2YWx1ZSk7XG4gICAgZWxzZVxuICAgICAgZGVsZXRlIHRoaXMuX3Byb21pc2U7XG4gIH1cbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciB0b0pTT04gPSByZXF1aXJlKCcuLi91dGlsL3RvX2pzb24nKTtcblxudmFyIExvZ2dpbmcgPSB7XG4gIExPR19MRVZFTFM6IHtcbiAgICBmYXRhbDogIDQsXG4gICAgZXJyb3I6ICAzLFxuICAgIHdhcm46ICAgMixcbiAgICBpbmZvOiAgIDEsXG4gICAgZGVidWc6ICAwXG4gIH0sXG5cbiAgd3JpdGVMb2c6IGZ1bmN0aW9uKG1lc3NhZ2VBcmdzLCBsZXZlbCkge1xuICAgIHZhciBsb2dnZXIgPSBMb2dnaW5nLmxvZ2dlciB8fCAoTG9nZ2luZy53cmFwcGVyIHx8IExvZ2dpbmcpLmxvZ2dlcjtcbiAgICBpZiAoIWxvZ2dlcikgcmV0dXJuO1xuXG4gICAgdmFyIGFyZ3MgICA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5hcHBseShtZXNzYWdlQXJncyksXG4gICAgICAgIGJhbm5lciA9ICdbRmF5ZScsXG4gICAgICAgIGtsYXNzICA9IHRoaXMuY2xhc3NOYW1lLFxuXG4gICAgICAgIG1lc3NhZ2UgPSBhcmdzLnNoaWZ0KCkucmVwbGFjZSgvXFw/L2csIGZ1bmN0aW9uKCkge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXR1cm4gdG9KU09OKGFyZ3Muc2hpZnQoKSk7XG4gICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHJldHVybiAnW09iamVjdF0nO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICBpZiAoa2xhc3MpIGJhbm5lciArPSAnLicgKyBrbGFzcztcbiAgICBiYW5uZXIgKz0gJ10gJztcblxuICAgIGlmICh0eXBlb2YgbG9nZ2VyW2xldmVsXSA9PT0gJ2Z1bmN0aW9uJylcbiAgICAgIGxvZ2dlcltsZXZlbF0oYmFubmVyICsgbWVzc2FnZSk7XG4gICAgZWxzZSBpZiAodHlwZW9mIGxvZ2dlciA9PT0gJ2Z1bmN0aW9uJylcbiAgICAgIGxvZ2dlcihiYW5uZXIgKyBtZXNzYWdlKTtcbiAgfVxufTtcblxuZm9yICh2YXIga2V5IGluIExvZ2dpbmcuTE9HX0xFVkVMUylcbiAgKGZ1bmN0aW9uKGxldmVsKSB7XG4gICAgTG9nZ2luZ1tsZXZlbF0gPSBmdW5jdGlvbigpIHtcbiAgICAgIHRoaXMud3JpdGVMb2coYXJndW1lbnRzLCBsZXZlbCk7XG4gICAgfTtcbiAgfSkoa2V5KTtcblxubW9kdWxlLmV4cG9ydHMgPSBMb2dnaW5nO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgYXNzaWduICAgICAgID0gcmVxdWlyZSgnLi4vdXRpbC9hc3NpZ24nKSxcbiAgICBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCcuLi91dGlsL2V2ZW50X2VtaXR0ZXInKTtcblxudmFyIFB1Ymxpc2hlciA9IHtcbiAgY291bnRMaXN0ZW5lcnM6IGZ1bmN0aW9uKGV2ZW50VHlwZSkge1xuICAgIHJldHVybiB0aGlzLmxpc3RlbmVycyhldmVudFR5cGUpLmxlbmd0aDtcbiAgfSxcblxuICBiaW5kOiBmdW5jdGlvbihldmVudFR5cGUsIGxpc3RlbmVyLCBjb250ZXh0KSB7XG4gICAgdmFyIHNsaWNlICAgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UsXG4gICAgICAgIGhhbmRsZXIgPSBmdW5jdGlvbigpIHsgbGlzdGVuZXIuYXBwbHkoY29udGV4dCwgc2xpY2UuY2FsbChhcmd1bWVudHMpKSB9O1xuXG4gICAgdGhpcy5fbGlzdGVuZXJzID0gdGhpcy5fbGlzdGVuZXJzIHx8IFtdO1xuICAgIHRoaXMuX2xpc3RlbmVycy5wdXNoKFtldmVudFR5cGUsIGxpc3RlbmVyLCBjb250ZXh0LCBoYW5kbGVyXSk7XG4gICAgcmV0dXJuIHRoaXMub24oZXZlbnRUeXBlLCBoYW5kbGVyKTtcbiAgfSxcblxuICB1bmJpbmQ6IGZ1bmN0aW9uKGV2ZW50VHlwZSwgbGlzdGVuZXIsIGNvbnRleHQpIHtcbiAgICB0aGlzLl9saXN0ZW5lcnMgPSB0aGlzLl9saXN0ZW5lcnMgfHwgW107XG4gICAgdmFyIG4gPSB0aGlzLl9saXN0ZW5lcnMubGVuZ3RoLCB0dXBsZTtcblxuICAgIHdoaWxlIChuLS0pIHtcbiAgICAgIHR1cGxlID0gdGhpcy5fbGlzdGVuZXJzW25dO1xuICAgICAgaWYgKHR1cGxlWzBdICE9PSBldmVudFR5cGUpIGNvbnRpbnVlO1xuICAgICAgaWYgKGxpc3RlbmVyICYmICh0dXBsZVsxXSAhPT0gbGlzdGVuZXIgfHwgdHVwbGVbMl0gIT09IGNvbnRleHQpKSBjb250aW51ZTtcbiAgICAgIHRoaXMuX2xpc3RlbmVycy5zcGxpY2UobiwgMSk7XG4gICAgICB0aGlzLnJlbW92ZUxpc3RlbmVyKGV2ZW50VHlwZSwgdHVwbGVbM10pO1xuICAgIH1cbiAgfVxufTtcblxuYXNzaWduKFB1Ymxpc2hlciwgRXZlbnRFbWl0dGVyLnByb3RvdHlwZSk7XG5QdWJsaXNoZXIudHJpZ2dlciA9IFB1Ymxpc2hlci5lbWl0O1xuXG5tb2R1bGUuZXhwb3J0cyA9IFB1Ymxpc2hlcjtcbiIsIid1c2Ugc3RyaWN0JztcblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIGFkZFRpbWVvdXQ6IGZ1bmN0aW9uKG5hbWUsIGRlbGF5LCBjYWxsYmFjaywgY29udGV4dCkge1xuICAgIHRoaXMuX3RpbWVvdXRzID0gdGhpcy5fdGltZW91dHMgfHwge307XG4gICAgaWYgKHRoaXMuX3RpbWVvdXRzLmhhc093blByb3BlcnR5KG5hbWUpKSByZXR1cm47XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHRoaXMuX3RpbWVvdXRzW25hbWVdID0gZ2xvYmFsLnNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICBkZWxldGUgc2VsZi5fdGltZW91dHNbbmFtZV07XG4gICAgICBjYWxsYmFjay5jYWxsKGNvbnRleHQpO1xuICAgIH0sIDEwMDAgKiBkZWxheSk7XG4gIH0sXG5cbiAgcmVtb3ZlVGltZW91dDogZnVuY3Rpb24obmFtZSkge1xuICAgIHRoaXMuX3RpbWVvdXRzID0gdGhpcy5fdGltZW91dHMgfHwge307XG4gICAgdmFyIHRpbWVvdXQgPSB0aGlzLl90aW1lb3V0c1tuYW1lXTtcbiAgICBpZiAoIXRpbWVvdXQpIHJldHVybjtcbiAgICBnbG9iYWwuY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgIGRlbGV0ZSB0aGlzLl90aW1lb3V0c1tuYW1lXTtcbiAgfSxcblxuICByZW1vdmVBbGxUaW1lb3V0czogZnVuY3Rpb24oKSB7XG4gICAgdGhpcy5fdGltZW91dHMgPSB0aGlzLl90aW1lb3V0cyB8fCB7fTtcbiAgICBmb3IgKHZhciBuYW1lIGluIHRoaXMuX3RpbWVvdXRzKSB0aGlzLnJlbW92ZVRpbWVvdXQobmFtZSk7XG4gIH1cbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBDbGFzcyAgICAgPSByZXF1aXJlKCcuLi91dGlsL2NsYXNzJyksXG4gICAgYXNzaWduICAgID0gcmVxdWlyZSgnLi4vdXRpbC9hc3NpZ24nKSxcbiAgICBQdWJsaXNoZXIgPSByZXF1aXJlKCcuLi9taXhpbnMvcHVibGlzaGVyJyksXG4gICAgR3JhbW1hciAgID0gcmVxdWlyZSgnLi9ncmFtbWFyJyk7XG5cbnZhciBDaGFubmVsID0gQ2xhc3Moe1xuICBpbml0aWFsaXplOiBmdW5jdGlvbihuYW1lKSB7XG4gICAgdGhpcy5pZCA9IHRoaXMubmFtZSA9IG5hbWU7XG4gIH0sXG5cbiAgcHVzaDogZnVuY3Rpb24obWVzc2FnZSkge1xuICAgIHRoaXMudHJpZ2dlcignbWVzc2FnZScsIG1lc3NhZ2UpO1xuICB9LFxuXG4gIGlzVW51c2VkOiBmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdGhpcy5jb3VudExpc3RlbmVycygnbWVzc2FnZScpID09PSAwO1xuICB9XG59KTtcblxuYXNzaWduKENoYW5uZWwucHJvdG90eXBlLCBQdWJsaXNoZXIpO1xuXG5hc3NpZ24oQ2hhbm5lbCwge1xuICBIQU5EU0hBS0U6ICAgICcvbWV0YS9oYW5kc2hha2UnLFxuICBDT05ORUNUOiAgICAgICcvbWV0YS9jb25uZWN0JyxcbiAgU1VCU0NSSUJFOiAgICAnL21ldGEvc3Vic2NyaWJlJyxcbiAgVU5TVUJTQ1JJQkU6ICAnL21ldGEvdW5zdWJzY3JpYmUnLFxuICBESVNDT05ORUNUOiAgICcvbWV0YS9kaXNjb25uZWN0JyxcblxuICBNRVRBOiAgICAgICAgICdtZXRhJyxcbiAgU0VSVklDRTogICAgICAnc2VydmljZScsXG5cbiAgZXhwYW5kOiBmdW5jdGlvbihuYW1lKSB7XG4gICAgdmFyIHNlZ21lbnRzID0gdGhpcy5wYXJzZShuYW1lKSxcbiAgICAgICAgY2hhbm5lbHMgPSBbJy8qKicsIG5hbWVdO1xuXG4gICAgdmFyIGNvcHkgPSBzZWdtZW50cy5zbGljZSgpO1xuICAgIGNvcHlbY29weS5sZW5ndGggLSAxXSA9ICcqJztcbiAgICBjaGFubmVscy5wdXNoKHRoaXMudW5wYXJzZShjb3B5KSk7XG5cbiAgICBmb3IgKHZhciBpID0gMSwgbiA9IHNlZ21lbnRzLmxlbmd0aDsgaSA8IG47IGkrKykge1xuICAgICAgY29weSA9IHNlZ21lbnRzLnNsaWNlKDAsIGkpO1xuICAgICAgY29weS5wdXNoKCcqKicpO1xuICAgICAgY2hhbm5lbHMucHVzaCh0aGlzLnVucGFyc2UoY29weSkpO1xuICAgIH1cblxuICAgIHJldHVybiBjaGFubmVscztcbiAgfSxcblxuICBpc1ZhbGlkOiBmdW5jdGlvbihuYW1lKSB7XG4gICAgcmV0dXJuIEdyYW1tYXIuQ0hBTk5FTF9OQU1FLnRlc3QobmFtZSkgfHxcbiAgICAgICAgICAgR3JhbW1hci5DSEFOTkVMX1BBVFRFUk4udGVzdChuYW1lKTtcbiAgfSxcblxuICBwYXJzZTogZnVuY3Rpb24obmFtZSkge1xuICAgIGlmICghdGhpcy5pc1ZhbGlkKG5hbWUpKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gbmFtZS5zcGxpdCgnLycpLnNsaWNlKDEpO1xuICB9LFxuXG4gIHVucGFyc2U6IGZ1bmN0aW9uKHNlZ21lbnRzKSB7XG4gICAgcmV0dXJuICcvJyArIHNlZ21lbnRzLmpvaW4oJy8nKTtcbiAgfSxcblxuICBpc01ldGE6IGZ1bmN0aW9uKG5hbWUpIHtcbiAgICB2YXIgc2VnbWVudHMgPSB0aGlzLnBhcnNlKG5hbWUpO1xuICAgIHJldHVybiBzZWdtZW50cyA/IChzZWdtZW50c1swXSA9PT0gdGhpcy5NRVRBKSA6IG51bGw7XG4gIH0sXG5cbiAgaXNTZXJ2aWNlOiBmdW5jdGlvbihuYW1lKSB7XG4gICAgdmFyIHNlZ21lbnRzID0gdGhpcy5wYXJzZShuYW1lKTtcbiAgICByZXR1cm4gc2VnbWVudHMgPyAoc2VnbWVudHNbMF0gPT09IHRoaXMuU0VSVklDRSkgOiBudWxsO1xuICB9LFxuXG4gIGlzU3Vic2NyaWJhYmxlOiBmdW5jdGlvbihuYW1lKSB7XG4gICAgaWYgKCF0aGlzLmlzVmFsaWQobmFtZSkpIHJldHVybiBudWxsO1xuICAgIHJldHVybiAhdGhpcy5pc01ldGEobmFtZSkgJiYgIXRoaXMuaXNTZXJ2aWNlKG5hbWUpO1xuICB9LFxuXG4gIFNldDogQ2xhc3Moe1xuICAgIGluaXRpYWxpemU6IGZ1bmN0aW9uKCkge1xuICAgICAgdGhpcy5fY2hhbm5lbHMgPSB7fTtcbiAgICB9LFxuXG4gICAgZ2V0S2V5czogZnVuY3Rpb24oKSB7XG4gICAgICB2YXIga2V5cyA9IFtdO1xuICAgICAgZm9yICh2YXIga2V5IGluIHRoaXMuX2NoYW5uZWxzKSBrZXlzLnB1c2goa2V5KTtcbiAgICAgIHJldHVybiBrZXlzO1xuICAgIH0sXG5cbiAgICByZW1vdmU6IGZ1bmN0aW9uKG5hbWUpIHtcbiAgICAgIGRlbGV0ZSB0aGlzLl9jaGFubmVsc1tuYW1lXTtcbiAgICB9LFxuXG4gICAgaGFzU3Vic2NyaXB0aW9uOiBmdW5jdGlvbihuYW1lKSB7XG4gICAgICByZXR1cm4gdGhpcy5fY2hhbm5lbHMuaGFzT3duUHJvcGVydHkobmFtZSk7XG4gICAgfSxcblxuICAgIHN1YnNjcmliZTogZnVuY3Rpb24obmFtZXMsIHN1YnNjcmlwdGlvbikge1xuICAgICAgdmFyIG5hbWU7XG4gICAgICBmb3IgKHZhciBpID0gMCwgbiA9IG5hbWVzLmxlbmd0aDsgaSA8IG47IGkrKykge1xuICAgICAgICBuYW1lID0gbmFtZXNbaV07XG4gICAgICAgIHZhciBjaGFubmVsID0gdGhpcy5fY2hhbm5lbHNbbmFtZV0gPSB0aGlzLl9jaGFubmVsc1tuYW1lXSB8fCBuZXcgQ2hhbm5lbChuYW1lKTtcbiAgICAgICAgY2hhbm5lbC5iaW5kKCdtZXNzYWdlJywgc3Vic2NyaXB0aW9uKTtcbiAgICAgIH1cbiAgICB9LFxuXG4gICAgdW5zdWJzY3JpYmU6IGZ1bmN0aW9uKG5hbWUsIHN1YnNjcmlwdGlvbikge1xuICAgICAgdmFyIGNoYW5uZWwgPSB0aGlzLl9jaGFubmVsc1tuYW1lXTtcbiAgICAgIGlmICghY2hhbm5lbCkgcmV0dXJuIGZhbHNlO1xuICAgICAgY2hhbm5lbC51bmJpbmQoJ21lc3NhZ2UnLCBzdWJzY3JpcHRpb24pO1xuXG4gICAgICBpZiAoY2hhbm5lbC5pc1VudXNlZCgpKSB7XG4gICAgICAgIHRoaXMucmVtb3ZlKG5hbWUpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH1cbiAgICB9LFxuXG4gICAgZGlzdHJpYnV0ZU1lc3NhZ2U6IGZ1bmN0aW9uKG1lc3NhZ2UpIHtcbiAgICAgIHZhciBjaGFubmVscyA9IENoYW5uZWwuZXhwYW5kKG1lc3NhZ2UuY2hhbm5lbCk7XG5cbiAgICAgIGZvciAodmFyIGkgPSAwLCBuID0gY2hhbm5lbHMubGVuZ3RoOyBpIDwgbjsgaSsrKSB7XG4gICAgICAgIHZhciBjaGFubmVsID0gdGhpcy5fY2hhbm5lbHNbY2hhbm5lbHNbaV1dO1xuICAgICAgICBpZiAoY2hhbm5lbCkgY2hhbm5lbC50cmlnZ2VyKCdtZXNzYWdlJywgbWVzc2FnZSk7XG4gICAgICB9XG4gICAgfVxuICB9KVxufSk7XG5cbm1vZHVsZS5leHBvcnRzID0gQ2hhbm5lbDtcbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIGFzYXAgICAgICAgICAgICA9IHJlcXVpcmUoJ2FzYXAnKSxcbiAgICBDbGFzcyAgICAgICAgICAgPSByZXF1aXJlKCcuLi91dGlsL2NsYXNzJyksXG4gICAgUHJvbWlzZSAgICAgICAgID0gcmVxdWlyZSgnLi4vdXRpbC9wcm9taXNlJyksXG4gICAgYXJyYXkgICAgICAgICAgID0gcmVxdWlyZSgnLi4vdXRpbC9hcnJheScpLFxuICAgIGJyb3dzZXIgICAgICAgICA9IHJlcXVpcmUoJy4uL3V0aWwvYnJvd3NlcicpLFxuICAgIGNvbnN0YW50cyAgICAgICA9IHJlcXVpcmUoJy4uL3V0aWwvY29uc3RhbnRzJyksXG4gICAgYXNzaWduICAgICAgICAgID0gcmVxdWlyZSgnLi4vdXRpbC9hc3NpZ24nKSxcbiAgICB2YWxpZGF0ZU9wdGlvbnMgPSByZXF1aXJlKCcuLi91dGlsL3ZhbGlkYXRlX29wdGlvbnMnKSxcbiAgICBEZWZlcnJhYmxlICAgICAgPSByZXF1aXJlKCcuLi9taXhpbnMvZGVmZXJyYWJsZScpLFxuICAgIExvZ2dpbmcgICAgICAgICA9IHJlcXVpcmUoJy4uL21peGlucy9sb2dnaW5nJyksXG4gICAgUHVibGlzaGVyICAgICAgID0gcmVxdWlyZSgnLi4vbWl4aW5zL3B1Ymxpc2hlcicpLFxuICAgIENoYW5uZWwgICAgICAgICA9IHJlcXVpcmUoJy4vY2hhbm5lbCcpLFxuICAgIERpc3BhdGNoZXIgICAgICA9IHJlcXVpcmUoJy4vZGlzcGF0Y2hlcicpLFxuICAgIEVycm9yICAgICAgICAgICA9IHJlcXVpcmUoJy4vZXJyb3InKSxcbiAgICBFeHRlbnNpYmxlICAgICAgPSByZXF1aXJlKCcuL2V4dGVuc2libGUnKSxcbiAgICBQdWJsaWNhdGlvbiAgICAgPSByZXF1aXJlKCcuL3B1YmxpY2F0aW9uJyksXG4gICAgU3Vic2NyaXB0aW9uICAgID0gcmVxdWlyZSgnLi9zdWJzY3JpcHRpb24nKTtcblxudmFyIENsaWVudCA9IENsYXNzKHsgY2xhc3NOYW1lOiAnQ2xpZW50JyxcbiAgVU5DT05ORUNURUQ6ICAxLFxuICBDT05ORUNUSU5HOiAgIDIsXG4gIENPTk5FQ1RFRDogICAgMyxcbiAgRElTQ09OTkVDVEVEOiA0LFxuXG4gIEhBTkRTSEFLRTogJ2hhbmRzaGFrZScsXG4gIFJFVFJZOiAgICAgJ3JldHJ5JyxcbiAgTk9ORTogICAgICAnbm9uZScsXG5cbiAgQ09OTkVDVElPTl9USU1FT1VUOiA2MCxcblxuICBERUZBVUxUX0VORFBPSU5UOiAnL2JheWV1eCcsXG4gIElOVEVSVkFMOiAgICAgICAgIDAsXG5cbiAgaW5pdGlhbGl6ZTogZnVuY3Rpb24oZW5kcG9pbnQsIG9wdGlvbnMpIHtcbiAgICB0aGlzLmluZm8oJ05ldyBjbGllbnQgY3JlYXRlZCBmb3IgPycsIGVuZHBvaW50KTtcbiAgICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcblxuICAgIHZhbGlkYXRlT3B0aW9ucyhvcHRpb25zLCBbJ2ludGVydmFsJywgJ3RpbWVvdXQnLCAnZW5kcG9pbnRzJywgJ3Byb3h5JywgJ3JldHJ5JywgJ3NjaGVkdWxlcicsICd3ZWJzb2NrZXRFeHRlbnNpb25zJywgJ3RscycsICdjYSddKTtcblxuICAgIHRoaXMuX2NoYW5uZWxzICAgPSBuZXcgQ2hhbm5lbC5TZXQoKTtcbiAgICB0aGlzLl9kaXNwYXRjaGVyID0gRGlzcGF0Y2hlci5jcmVhdGUodGhpcywgZW5kcG9pbnQgfHwgdGhpcy5ERUZBVUxUX0VORFBPSU5ULCBvcHRpb25zKTtcblxuICAgIHRoaXMuX21lc3NhZ2VJZCA9IDA7XG4gICAgdGhpcy5fc3RhdGUgICAgID0gdGhpcy5VTkNPTk5FQ1RFRDtcblxuICAgIHRoaXMuX3Jlc3BvbnNlQ2FsbGJhY2tzID0ge307XG5cbiAgICB0aGlzLl9hZHZpY2UgPSB7XG4gICAgICByZWNvbm5lY3Q6IHRoaXMuUkVUUlksXG4gICAgICBpbnRlcnZhbDogIDEwMDAgKiAob3B0aW9ucy5pbnRlcnZhbCB8fCB0aGlzLklOVEVSVkFMKSxcbiAgICAgIHRpbWVvdXQ6ICAgMTAwMCAqIChvcHRpb25zLnRpbWVvdXQgIHx8IHRoaXMuQ09OTkVDVElPTl9USU1FT1VUKVxuICAgIH07XG4gICAgdGhpcy5fZGlzcGF0Y2hlci50aW1lb3V0ID0gdGhpcy5fYWR2aWNlLnRpbWVvdXQgLyAxMDAwO1xuXG4gICAgdGhpcy5fZGlzcGF0Y2hlci5iaW5kKCdtZXNzYWdlJywgdGhpcy5fcmVjZWl2ZU1lc3NhZ2UsIHRoaXMpO1xuXG4gICAgaWYgKGJyb3dzZXIuRXZlbnQgJiYgZ2xvYmFsLm9uYmVmb3JldW5sb2FkICE9PSB1bmRlZmluZWQpXG4gICAgICBicm93c2VyLkV2ZW50Lm9uKGdsb2JhbCwgJ2JlZm9yZXVubG9hZCcsIGZ1bmN0aW9uKCkge1xuICAgICAgICBpZiAoYXJyYXkuaW5kZXhPZih0aGlzLl9kaXNwYXRjaGVyLl9kaXNhYmxlZCwgJ2F1dG9kaXNjb25uZWN0JykgPCAwKVxuICAgICAgICAgIHRoaXMuZGlzY29ubmVjdCgpO1xuICAgICAgfSwgdGhpcyk7XG4gIH0sXG5cbiAgYWRkV2Vic29ja2V0RXh0ZW5zaW9uOiBmdW5jdGlvbihleHRlbnNpb24pIHtcbiAgICByZXR1cm4gdGhpcy5fZGlzcGF0Y2hlci5hZGRXZWJzb2NrZXRFeHRlbnNpb24oZXh0ZW5zaW9uKTtcbiAgfSxcblxuICBkaXNhYmxlOiBmdW5jdGlvbihmZWF0dXJlKSB7XG4gICAgcmV0dXJuIHRoaXMuX2Rpc3BhdGNoZXIuZGlzYWJsZShmZWF0dXJlKTtcbiAgfSxcblxuICBzZXRIZWFkZXI6IGZ1bmN0aW9uKG5hbWUsIHZhbHVlKSB7XG4gICAgcmV0dXJuIHRoaXMuX2Rpc3BhdGNoZXIuc2V0SGVhZGVyKG5hbWUsIHZhbHVlKTtcbiAgfSxcblxuICAvLyBSZXF1ZXN0XG4gIC8vIE1VU1QgaW5jbHVkZTogICogY2hhbm5lbFxuICAvLyAgICAgICAgICAgICAgICAqIHZlcnNpb25cbiAgLy8gICAgICAgICAgICAgICAgKiBzdXBwb3J0ZWRDb25uZWN0aW9uVHlwZXNcbiAgLy8gTUFZIGluY2x1ZGU6ICAgKiBtaW5pbXVtVmVyc2lvblxuICAvLyAgICAgICAgICAgICAgICAqIGV4dFxuICAvLyAgICAgICAgICAgICAgICAqIGlkXG4gIC8vXG4gIC8vIFN1Y2Nlc3MgUmVzcG9uc2UgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEZhaWxlZCBSZXNwb25zZVxuICAvLyBNVVNUIGluY2x1ZGU6ICAqIGNoYW5uZWwgICAgICAgICAgICAgICAgICAgICBNVVNUIGluY2x1ZGU6ICAqIGNoYW5uZWxcbiAgLy8gICAgICAgICAgICAgICAgKiB2ZXJzaW9uICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKiBzdWNjZXNzZnVsXG4gIC8vICAgICAgICAgICAgICAgICogc3VwcG9ydGVkQ29ubmVjdGlvblR5cGVzICAgICAgICAgICAgICAgICAgICogZXJyb3JcbiAgLy8gICAgICAgICAgICAgICAgKiBjbGllbnRJZCAgICAgICAgICAgICAgICAgICAgTUFZIGluY2x1ZGU6ICAgKiBzdXBwb3J0ZWRDb25uZWN0aW9uVHlwZXNcbiAgLy8gICAgICAgICAgICAgICAgKiBzdWNjZXNzZnVsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKiBhZHZpY2VcbiAgLy8gTUFZIGluY2x1ZGU6ICAgKiBtaW5pbXVtVmVyc2lvbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKiB2ZXJzaW9uXG4gIC8vICAgICAgICAgICAgICAgICogYWR2aWNlICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICogbWluaW11bVZlcnNpb25cbiAgLy8gICAgICAgICAgICAgICAgKiBleHQgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKiBleHRcbiAgLy8gICAgICAgICAgICAgICAgKiBpZCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKiBpZFxuICAvLyAgICAgICAgICAgICAgICAqIGF1dGhTdWNjZXNzZnVsXG4gIGhhbmRzaGFrZTogZnVuY3Rpb24oY2FsbGJhY2ssIGNvbnRleHQpIHtcbiAgICBpZiAodGhpcy5fYWR2aWNlLnJlY29ubmVjdCA9PT0gdGhpcy5OT05FKSByZXR1cm47XG4gICAgaWYgKHRoaXMuX3N0YXRlICE9PSB0aGlzLlVOQ09OTkVDVEVEKSByZXR1cm47XG5cbiAgICB0aGlzLl9zdGF0ZSA9IHRoaXMuQ09OTkVDVElORztcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICB0aGlzLmluZm8oJ0luaXRpYXRpbmcgaGFuZHNoYWtlIHdpdGggPycsIHRoaXMuX2Rpc3BhdGNoZXIuZW5kcG9pbnQuaHJlZik7XG4gICAgdGhpcy5fZGlzcGF0Y2hlci5zZWxlY3RUcmFuc3BvcnQoY29uc3RhbnRzLk1BTkRBVE9SWV9DT05ORUNUSU9OX1RZUEVTKTtcblxuICAgIHRoaXMuX3NlbmRNZXNzYWdlKHtcbiAgICAgIGNoYW5uZWw6ICAgICAgICAgICAgICAgICAgQ2hhbm5lbC5IQU5EU0hBS0UsXG4gICAgICB2ZXJzaW9uOiAgICAgICAgICAgICAgICAgIGNvbnN0YW50cy5CQVlFVVhfVkVSU0lPTixcbiAgICAgIHN1cHBvcnRlZENvbm5lY3Rpb25UeXBlczogdGhpcy5fZGlzcGF0Y2hlci5nZXRDb25uZWN0aW9uVHlwZXMoKVxuXG4gICAgfSwge30sIGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG5cbiAgICAgIGlmIChyZXNwb25zZS5zdWNjZXNzZnVsKSB7XG4gICAgICAgIHRoaXMuX3N0YXRlID0gdGhpcy5DT05ORUNURUQ7XG4gICAgICAgIHRoaXMuX2Rpc3BhdGNoZXIuY2xpZW50SWQgID0gcmVzcG9uc2UuY2xpZW50SWQ7XG5cbiAgICAgICAgdGhpcy5fZGlzcGF0Y2hlci5zZWxlY3RUcmFuc3BvcnQocmVzcG9uc2Uuc3VwcG9ydGVkQ29ubmVjdGlvblR5cGVzKTtcblxuICAgICAgICB0aGlzLmluZm8oJ0hhbmRzaGFrZSBzdWNjZXNzZnVsOiA/JywgdGhpcy5fZGlzcGF0Y2hlci5jbGllbnRJZCk7XG5cbiAgICAgICAgdGhpcy5zdWJzY3JpYmUodGhpcy5fY2hhbm5lbHMuZ2V0S2V5cygpLCB0cnVlKTtcbiAgICAgICAgaWYgKGNhbGxiYWNrKSBhc2FwKGZ1bmN0aW9uKCkgeyBjYWxsYmFjay5jYWxsKGNvbnRleHQpIH0pO1xuXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLmluZm8oJ0hhbmRzaGFrZSB1bnN1Y2Nlc3NmdWwnKTtcbiAgICAgICAgZ2xvYmFsLnNldFRpbWVvdXQoZnVuY3Rpb24oKSB7IHNlbGYuaGFuZHNoYWtlKGNhbGxiYWNrLCBjb250ZXh0KSB9LCB0aGlzLl9kaXNwYXRjaGVyLnJldHJ5ICogMTAwMCk7XG4gICAgICAgIHRoaXMuX3N0YXRlID0gdGhpcy5VTkNPTk5FQ1RFRDtcbiAgICAgIH1cbiAgICB9LCB0aGlzKTtcbiAgfSxcblxuICAvLyBSZXF1ZXN0ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgUmVzcG9uc2VcbiAgLy8gTVVTVCBpbmNsdWRlOiAgKiBjaGFubmVsICAgICAgICAgICAgIE1VU1QgaW5jbHVkZTogICogY2hhbm5lbFxuICAvLyAgICAgICAgICAgICAgICAqIGNsaWVudElkICAgICAgICAgICAgICAgICAgICAgICAgICAgKiBzdWNjZXNzZnVsXG4gIC8vICAgICAgICAgICAgICAgICogY29ubmVjdGlvblR5cGUgICAgICAgICAgICAgICAgICAgICAqIGNsaWVudElkXG4gIC8vIE1BWSBpbmNsdWRlOiAgICogZXh0ICAgICAgICAgICAgICAgICBNQVkgaW5jbHVkZTogICAqIGVycm9yXG4gIC8vICAgICAgICAgICAgICAgICogaWQgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqIGFkdmljZVxuICAvLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKiBleHRcbiAgLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICogaWRcbiAgLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICogdGltZXN0YW1wXG4gIGNvbm5lY3Q6IGZ1bmN0aW9uKGNhbGxiYWNrLCBjb250ZXh0KSB7XG4gICAgaWYgKHRoaXMuX2FkdmljZS5yZWNvbm5lY3QgPT09IHRoaXMuTk9ORSkgcmV0dXJuO1xuICAgIGlmICh0aGlzLl9zdGF0ZSA9PT0gdGhpcy5ESVNDT05ORUNURUQpIHJldHVybjtcblxuICAgIGlmICh0aGlzLl9zdGF0ZSA9PT0gdGhpcy5VTkNPTk5FQ1RFRClcbiAgICAgIHJldHVybiB0aGlzLmhhbmRzaGFrZShmdW5jdGlvbigpIHsgdGhpcy5jb25uZWN0KGNhbGxiYWNrLCBjb250ZXh0KSB9LCB0aGlzKTtcblxuICAgIHRoaXMuY2FsbGJhY2soY2FsbGJhY2ssIGNvbnRleHQpO1xuICAgIGlmICh0aGlzLl9zdGF0ZSAhPT0gdGhpcy5DT05ORUNURUQpIHJldHVybjtcblxuICAgIHRoaXMuaW5mbygnQ2FsbGluZyBkZWZlcnJlZCBhY3Rpb25zIGZvciA/JywgdGhpcy5fZGlzcGF0Y2hlci5jbGllbnRJZCk7XG4gICAgdGhpcy5zZXREZWZlcnJlZFN0YXR1cygnc3VjY2VlZGVkJyk7XG4gICAgdGhpcy5zZXREZWZlcnJlZFN0YXR1cygndW5rbm93bicpO1xuXG4gICAgaWYgKHRoaXMuX2Nvbm5lY3RSZXF1ZXN0KSByZXR1cm47XG4gICAgdGhpcy5fY29ubmVjdFJlcXVlc3QgPSB0cnVlO1xuXG4gICAgdGhpcy5pbmZvKCdJbml0aWF0aW5nIGNvbm5lY3Rpb24gZm9yID8nLCB0aGlzLl9kaXNwYXRjaGVyLmNsaWVudElkKTtcblxuICAgIHRoaXMuX3NlbmRNZXNzYWdlKHtcbiAgICAgIGNoYW5uZWw6ICAgICAgICBDaGFubmVsLkNPTk5FQ1QsXG4gICAgICBjbGllbnRJZDogICAgICAgdGhpcy5fZGlzcGF0Y2hlci5jbGllbnRJZCxcbiAgICAgIGNvbm5lY3Rpb25UeXBlOiB0aGlzLl9kaXNwYXRjaGVyLmNvbm5lY3Rpb25UeXBlXG5cbiAgICB9LCB7fSwgdGhpcy5fY3ljbGVDb25uZWN0aW9uLCB0aGlzKTtcbiAgfSxcblxuICAvLyBSZXF1ZXN0ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgUmVzcG9uc2VcbiAgLy8gTVVTVCBpbmNsdWRlOiAgKiBjaGFubmVsICAgICAgICAgICAgIE1VU1QgaW5jbHVkZTogICogY2hhbm5lbFxuICAvLyAgICAgICAgICAgICAgICAqIGNsaWVudElkICAgICAgICAgICAgICAgICAgICAgICAgICAgKiBzdWNjZXNzZnVsXG4gIC8vIE1BWSBpbmNsdWRlOiAgICogZXh0ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqIGNsaWVudElkXG4gIC8vICAgICAgICAgICAgICAgICogaWQgICAgICAgICAgICAgICAgICBNQVkgaW5jbHVkZTogICAqIGVycm9yXG4gIC8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqIGV4dFxuICAvLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKiBpZFxuICBkaXNjb25uZWN0OiBmdW5jdGlvbigpIHtcbiAgICBpZiAodGhpcy5fc3RhdGUgIT09IHRoaXMuQ09OTkVDVEVEKSByZXR1cm47XG4gICAgdGhpcy5fc3RhdGUgPSB0aGlzLkRJU0NPTk5FQ1RFRDtcblxuICAgIHRoaXMuaW5mbygnRGlzY29ubmVjdGluZyA/JywgdGhpcy5fZGlzcGF0Y2hlci5jbGllbnRJZCk7XG4gICAgdmFyIHByb21pc2UgPSBuZXcgUHVibGljYXRpb24oKTtcblxuICAgIHRoaXMuX3NlbmRNZXNzYWdlKHtcbiAgICAgIGNoYW5uZWw6ICBDaGFubmVsLkRJU0NPTk5FQ1QsXG4gICAgICBjbGllbnRJZDogdGhpcy5fZGlzcGF0Y2hlci5jbGllbnRJZFxuXG4gICAgfSwge30sIGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICBpZiAocmVzcG9uc2Uuc3VjY2Vzc2Z1bCkge1xuICAgICAgICB0aGlzLl9kaXNwYXRjaGVyLmNsb3NlKCk7XG4gICAgICAgIHByb21pc2Uuc2V0RGVmZXJyZWRTdGF0dXMoJ3N1Y2NlZWRlZCcpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcHJvbWlzZS5zZXREZWZlcnJlZFN0YXR1cygnZmFpbGVkJywgRXJyb3IucGFyc2UocmVzcG9uc2UuZXJyb3IpKTtcbiAgICAgIH1cbiAgICB9LCB0aGlzKTtcblxuICAgIHRoaXMuaW5mbygnQ2xlYXJpbmcgY2hhbm5lbCBsaXN0ZW5lcnMgZm9yID8nLCB0aGlzLl9kaXNwYXRjaGVyLmNsaWVudElkKTtcbiAgICB0aGlzLl9jaGFubmVscyA9IG5ldyBDaGFubmVsLlNldCgpO1xuXG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH0sXG5cbiAgLy8gUmVxdWVzdCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFJlc3BvbnNlXG4gIC8vIE1VU1QgaW5jbHVkZTogICogY2hhbm5lbCAgICAgICAgICAgICBNVVNUIGluY2x1ZGU6ICAqIGNoYW5uZWxcbiAgLy8gICAgICAgICAgICAgICAgKiBjbGllbnRJZCAgICAgICAgICAgICAgICAgICAgICAgICAgICogc3VjY2Vzc2Z1bFxuICAvLyAgICAgICAgICAgICAgICAqIHN1YnNjcmlwdGlvbiAgICAgICAgICAgICAgICAgICAgICAgKiBjbGllbnRJZFxuICAvLyBNQVkgaW5jbHVkZTogICAqIGV4dCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKiBzdWJzY3JpcHRpb25cbiAgLy8gICAgICAgICAgICAgICAgKiBpZCAgICAgICAgICAgICAgICAgIE1BWSBpbmNsdWRlOiAgICogZXJyb3JcbiAgLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICogYWR2aWNlXG4gIC8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqIGV4dFxuICAvLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKiBpZFxuICAvLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKiB0aW1lc3RhbXBcbiAgc3Vic2NyaWJlOiBmdW5jdGlvbihjaGFubmVsLCBjYWxsYmFjaywgY29udGV4dCkge1xuICAgIGlmIChjaGFubmVsIGluc3RhbmNlb2YgQXJyYXkpXG4gICAgICByZXR1cm4gYXJyYXkubWFwKGNoYW5uZWwsIGZ1bmN0aW9uKGMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuc3Vic2NyaWJlKGMsIGNhbGxiYWNrLCBjb250ZXh0KTtcbiAgICAgIH0sIHRoaXMpO1xuXG4gICAgdmFyIHN1YnNjcmlwdGlvbiA9IG5ldyBTdWJzY3JpcHRpb24odGhpcywgY2hhbm5lbCwgY2FsbGJhY2ssIGNvbnRleHQpLFxuICAgICAgICBmb3JjZSAgICAgICAgPSAoY2FsbGJhY2sgPT09IHRydWUpLFxuICAgICAgICBoYXNTdWJzY3JpYmUgPSB0aGlzLl9jaGFubmVscy5oYXNTdWJzY3JpcHRpb24oY2hhbm5lbCk7XG5cbiAgICBpZiAoaGFzU3Vic2NyaWJlICYmICFmb3JjZSkge1xuICAgICAgdGhpcy5fY2hhbm5lbHMuc3Vic2NyaWJlKFtjaGFubmVsXSwgc3Vic2NyaXB0aW9uKTtcbiAgICAgIHN1YnNjcmlwdGlvbi5zZXREZWZlcnJlZFN0YXR1cygnc3VjY2VlZGVkJyk7XG4gICAgICByZXR1cm4gc3Vic2NyaXB0aW9uO1xuICAgIH1cblxuICAgIHRoaXMuY29ubmVjdChmdW5jdGlvbigpIHtcbiAgICAgIHRoaXMuaW5mbygnQ2xpZW50ID8gYXR0ZW1wdGluZyB0byBzdWJzY3JpYmUgdG8gPycsIHRoaXMuX2Rpc3BhdGNoZXIuY2xpZW50SWQsIGNoYW5uZWwpO1xuICAgICAgaWYgKCFmb3JjZSkgdGhpcy5fY2hhbm5lbHMuc3Vic2NyaWJlKFtjaGFubmVsXSwgc3Vic2NyaXB0aW9uKTtcblxuICAgICAgdGhpcy5fc2VuZE1lc3NhZ2Uoe1xuICAgICAgICBjaGFubmVsOiAgICAgIENoYW5uZWwuU1VCU0NSSUJFLFxuICAgICAgICBjbGllbnRJZDogICAgIHRoaXMuX2Rpc3BhdGNoZXIuY2xpZW50SWQsXG4gICAgICAgIHN1YnNjcmlwdGlvbjogY2hhbm5lbFxuXG4gICAgICB9LCB7fSwgZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgICAgaWYgKCFyZXNwb25zZS5zdWNjZXNzZnVsKSB7XG4gICAgICAgICAgc3Vic2NyaXB0aW9uLnNldERlZmVycmVkU3RhdHVzKCdmYWlsZWQnLCBFcnJvci5wYXJzZShyZXNwb25zZS5lcnJvcikpO1xuICAgICAgICAgIHJldHVybiB0aGlzLl9jaGFubmVscy51bnN1YnNjcmliZShjaGFubmVsLCBzdWJzY3JpcHRpb24pO1xuICAgICAgICB9XG5cbiAgICAgICAgdmFyIGNoYW5uZWxzID0gW10uY29uY2F0KHJlc3BvbnNlLnN1YnNjcmlwdGlvbik7XG4gICAgICAgIHRoaXMuaW5mbygnU3Vic2NyaXB0aW9uIGFja25vd2xlZGdlZCBmb3IgPyB0byA/JywgdGhpcy5fZGlzcGF0Y2hlci5jbGllbnRJZCwgY2hhbm5lbHMpO1xuICAgICAgICBzdWJzY3JpcHRpb24uc2V0RGVmZXJyZWRTdGF0dXMoJ3N1Y2NlZWRlZCcpO1xuICAgICAgfSwgdGhpcyk7XG4gICAgfSwgdGhpcyk7XG5cbiAgICByZXR1cm4gc3Vic2NyaXB0aW9uO1xuICB9LFxuXG4gIC8vIFJlcXVlc3QgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBSZXNwb25zZVxuICAvLyBNVVNUIGluY2x1ZGU6ICAqIGNoYW5uZWwgICAgICAgICAgICAgTVVTVCBpbmNsdWRlOiAgKiBjaGFubmVsXG4gIC8vICAgICAgICAgICAgICAgICogY2xpZW50SWQgICAgICAgICAgICAgICAgICAgICAgICAgICAqIHN1Y2Nlc3NmdWxcbiAgLy8gICAgICAgICAgICAgICAgKiBzdWJzY3JpcHRpb24gICAgICAgICAgICAgICAgICAgICAgICogY2xpZW50SWRcbiAgLy8gTUFZIGluY2x1ZGU6ICAgKiBleHQgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICogc3Vic2NyaXB0aW9uXG4gIC8vICAgICAgICAgICAgICAgICogaWQgICAgICAgICAgICAgICAgICBNQVkgaW5jbHVkZTogICAqIGVycm9yXG4gIC8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqIGFkdmljZVxuICAvLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKiBleHRcbiAgLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICogaWRcbiAgLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICogdGltZXN0YW1wXG4gIHVuc3Vic2NyaWJlOiBmdW5jdGlvbihjaGFubmVsLCBzdWJzY3JpcHRpb24pIHtcbiAgICBpZiAoY2hhbm5lbCBpbnN0YW5jZW9mIEFycmF5KVxuICAgICAgcmV0dXJuIGFycmF5Lm1hcChjaGFubmVsLCBmdW5jdGlvbihjKSB7XG4gICAgICAgIHJldHVybiB0aGlzLnVuc3Vic2NyaWJlKGMsIHN1YnNjcmlwdGlvbik7XG4gICAgICB9LCB0aGlzKTtcblxuICAgIHZhciBkZWFkID0gdGhpcy5fY2hhbm5lbHMudW5zdWJzY3JpYmUoY2hhbm5lbCwgc3Vic2NyaXB0aW9uKTtcbiAgICBpZiAoIWRlYWQpIHJldHVybjtcblxuICAgIHRoaXMuY29ubmVjdChmdW5jdGlvbigpIHtcbiAgICAgIHRoaXMuaW5mbygnQ2xpZW50ID8gYXR0ZW1wdGluZyB0byB1bnN1YnNjcmliZSBmcm9tID8nLCB0aGlzLl9kaXNwYXRjaGVyLmNsaWVudElkLCBjaGFubmVsKTtcblxuICAgICAgdGhpcy5fc2VuZE1lc3NhZ2Uoe1xuICAgICAgICBjaGFubmVsOiAgICAgIENoYW5uZWwuVU5TVUJTQ1JJQkUsXG4gICAgICAgIGNsaWVudElkOiAgICAgdGhpcy5fZGlzcGF0Y2hlci5jbGllbnRJZCxcbiAgICAgICAgc3Vic2NyaXB0aW9uOiBjaGFubmVsXG5cbiAgICAgIH0sIHt9LCBmdW5jdGlvbihyZXNwb25zZSkge1xuICAgICAgICBpZiAoIXJlc3BvbnNlLnN1Y2Nlc3NmdWwpIHJldHVybjtcblxuICAgICAgICB2YXIgY2hhbm5lbHMgPSBbXS5jb25jYXQocmVzcG9uc2Uuc3Vic2NyaXB0aW9uKTtcbiAgICAgICAgdGhpcy5pbmZvKCdVbnN1YnNjcmlwdGlvbiBhY2tub3dsZWRnZWQgZm9yID8gZnJvbSA/JywgdGhpcy5fZGlzcGF0Y2hlci5jbGllbnRJZCwgY2hhbm5lbHMpO1xuICAgICAgfSwgdGhpcyk7XG4gICAgfSwgdGhpcyk7XG4gIH0sXG5cbiAgLy8gUmVxdWVzdCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFJlc3BvbnNlXG4gIC8vIE1VU1QgaW5jbHVkZTogICogY2hhbm5lbCAgICAgICAgICAgICBNVVNUIGluY2x1ZGU6ICAqIGNoYW5uZWxcbiAgLy8gICAgICAgICAgICAgICAgKiBkYXRhICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICogc3VjY2Vzc2Z1bFxuICAvLyBNQVkgaW5jbHVkZTogICAqIGNsaWVudElkICAgICAgICAgICAgTUFZIGluY2x1ZGU6ICAgKiBpZFxuICAvLyAgICAgICAgICAgICAgICAqIGlkICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKiBlcnJvclxuICAvLyAgICAgICAgICAgICAgICAqIGV4dCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKiBleHRcbiAgcHVibGlzaDogZnVuY3Rpb24oY2hhbm5lbCwgZGF0YSwgb3B0aW9ucykge1xuICAgIHZhbGlkYXRlT3B0aW9ucyhvcHRpb25zIHx8IHt9LCBbJ2F0dGVtcHRzJywgJ2RlYWRsaW5lJ10pO1xuICAgIHZhciBwdWJsaWNhdGlvbiA9IG5ldyBQdWJsaWNhdGlvbigpO1xuXG4gICAgdGhpcy5jb25uZWN0KGZ1bmN0aW9uKCkge1xuICAgICAgdGhpcy5pbmZvKCdDbGllbnQgPyBxdWV1ZWluZyBwdWJsaXNoZWQgbWVzc2FnZSB0byA/OiA/JywgdGhpcy5fZGlzcGF0Y2hlci5jbGllbnRJZCwgY2hhbm5lbCwgZGF0YSk7XG5cbiAgICAgIHRoaXMuX3NlbmRNZXNzYWdlKHtcbiAgICAgICAgY2hhbm5lbDogIGNoYW5uZWwsXG4gICAgICAgIGRhdGE6ICAgICBkYXRhLFxuICAgICAgICBjbGllbnRJZDogdGhpcy5fZGlzcGF0Y2hlci5jbGllbnRJZFxuXG4gICAgICB9LCBvcHRpb25zLCBmdW5jdGlvbihyZXNwb25zZSkge1xuICAgICAgICBpZiAocmVzcG9uc2Uuc3VjY2Vzc2Z1bClcbiAgICAgICAgICBwdWJsaWNhdGlvbi5zZXREZWZlcnJlZFN0YXR1cygnc3VjY2VlZGVkJyk7XG4gICAgICAgIGVsc2VcbiAgICAgICAgICBwdWJsaWNhdGlvbi5zZXREZWZlcnJlZFN0YXR1cygnZmFpbGVkJywgRXJyb3IucGFyc2UocmVzcG9uc2UuZXJyb3IpKTtcbiAgICAgIH0sIHRoaXMpO1xuICAgIH0sIHRoaXMpO1xuXG4gICAgcmV0dXJuIHB1YmxpY2F0aW9uO1xuICB9LFxuXG4gIF9zZW5kTWVzc2FnZTogZnVuY3Rpb24obWVzc2FnZSwgb3B0aW9ucywgY2FsbGJhY2ssIGNvbnRleHQpIHtcbiAgICBtZXNzYWdlLmlkID0gdGhpcy5fZ2VuZXJhdGVNZXNzYWdlSWQoKTtcblxuICAgIHZhciB0aW1lb3V0ID0gdGhpcy5fYWR2aWNlLnRpbWVvdXRcbiAgICAgICAgICAgICAgICA/IDEuMiAqIHRoaXMuX2FkdmljZS50aW1lb3V0IC8gMTAwMFxuICAgICAgICAgICAgICAgIDogMS4yICogdGhpcy5fZGlzcGF0Y2hlci5yZXRyeTtcblxuICAgIHRoaXMucGlwZVRocm91Z2hFeHRlbnNpb25zKCdvdXRnb2luZycsIG1lc3NhZ2UsIG51bGwsIGZ1bmN0aW9uKG1lc3NhZ2UpIHtcbiAgICAgIGlmICghbWVzc2FnZSkgcmV0dXJuO1xuICAgICAgaWYgKGNhbGxiYWNrKSB0aGlzLl9yZXNwb25zZUNhbGxiYWNrc1ttZXNzYWdlLmlkXSA9IFtjYWxsYmFjaywgY29udGV4dF07XG4gICAgICB0aGlzLl9kaXNwYXRjaGVyLnNlbmRNZXNzYWdlKG1lc3NhZ2UsIHRpbWVvdXQsIG9wdGlvbnMgfHwge30pO1xuICAgIH0sIHRoaXMpO1xuICB9LFxuXG4gIF9nZW5lcmF0ZU1lc3NhZ2VJZDogZnVuY3Rpb24oKSB7XG4gICAgdGhpcy5fbWVzc2FnZUlkICs9IDE7XG4gICAgaWYgKHRoaXMuX21lc3NhZ2VJZCA+PSBNYXRoLnBvdygyLDMyKSkgdGhpcy5fbWVzc2FnZUlkID0gMDtcbiAgICByZXR1cm4gdGhpcy5fbWVzc2FnZUlkLnRvU3RyaW5nKDM2KTtcbiAgfSxcblxuICBfcmVjZWl2ZU1lc3NhZ2U6IGZ1bmN0aW9uKG1lc3NhZ2UpIHtcbiAgICB2YXIgaWQgPSBtZXNzYWdlLmlkLCBjYWxsYmFjaztcblxuICAgIGlmIChtZXNzYWdlLnN1Y2Nlc3NmdWwgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY2FsbGJhY2sgPSB0aGlzLl9yZXNwb25zZUNhbGxiYWNrc1tpZF07XG4gICAgICBkZWxldGUgdGhpcy5fcmVzcG9uc2VDYWxsYmFja3NbaWRdO1xuICAgIH1cblxuICAgIHRoaXMucGlwZVRocm91Z2hFeHRlbnNpb25zKCdpbmNvbWluZycsIG1lc3NhZ2UsIG51bGwsIGZ1bmN0aW9uKG1lc3NhZ2UpIHtcbiAgICAgIGlmICghbWVzc2FnZSkgcmV0dXJuO1xuICAgICAgaWYgKG1lc3NhZ2UuYWR2aWNlKSB0aGlzLl9oYW5kbGVBZHZpY2UobWVzc2FnZS5hZHZpY2UpO1xuICAgICAgdGhpcy5fZGVsaXZlck1lc3NhZ2UobWVzc2FnZSk7XG4gICAgICBpZiAoY2FsbGJhY2spIGNhbGxiYWNrWzBdLmNhbGwoY2FsbGJhY2tbMV0sIG1lc3NhZ2UpO1xuICAgIH0sIHRoaXMpO1xuICB9LFxuXG4gIF9oYW5kbGVBZHZpY2U6IGZ1bmN0aW9uKGFkdmljZSkge1xuICAgIGFzc2lnbih0aGlzLl9hZHZpY2UsIGFkdmljZSk7XG4gICAgdGhpcy5fZGlzcGF0Y2hlci50aW1lb3V0ID0gdGhpcy5fYWR2aWNlLnRpbWVvdXQgLyAxMDAwO1xuXG4gICAgaWYgKHRoaXMuX2FkdmljZS5yZWNvbm5lY3QgPT09IHRoaXMuSEFORFNIQUtFICYmIHRoaXMuX3N0YXRlICE9PSB0aGlzLkRJU0NPTk5FQ1RFRCkge1xuICAgICAgdGhpcy5fc3RhdGUgPSB0aGlzLlVOQ09OTkVDVEVEO1xuICAgICAgdGhpcy5fZGlzcGF0Y2hlci5jbGllbnRJZCA9IG51bGw7XG4gICAgICB0aGlzLl9jeWNsZUNvbm5lY3Rpb24oKTtcbiAgICB9XG4gIH0sXG5cbiAgX2RlbGl2ZXJNZXNzYWdlOiBmdW5jdGlvbihtZXNzYWdlKSB7XG4gICAgaWYgKCFtZXNzYWdlLmNoYW5uZWwgfHwgbWVzc2FnZS5kYXRhID09PSB1bmRlZmluZWQpIHJldHVybjtcbiAgICB0aGlzLmluZm8oJ0NsaWVudCA/IGNhbGxpbmcgbGlzdGVuZXJzIGZvciA/IHdpdGggPycsIHRoaXMuX2Rpc3BhdGNoZXIuY2xpZW50SWQsIG1lc3NhZ2UuY2hhbm5lbCwgbWVzc2FnZS5kYXRhKTtcbiAgICB0aGlzLl9jaGFubmVscy5kaXN0cmlidXRlTWVzc2FnZShtZXNzYWdlKTtcbiAgfSxcblxuICBfY3ljbGVDb25uZWN0aW9uOiBmdW5jdGlvbigpIHtcbiAgICBpZiAodGhpcy5fY29ubmVjdFJlcXVlc3QpIHtcbiAgICAgIHRoaXMuX2Nvbm5lY3RSZXF1ZXN0ID0gbnVsbDtcbiAgICAgIHRoaXMuaW5mbygnQ2xvc2VkIGNvbm5lY3Rpb24gZm9yID8nLCB0aGlzLl9kaXNwYXRjaGVyLmNsaWVudElkKTtcbiAgICB9XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGdsb2JhbC5zZXRUaW1lb3V0KGZ1bmN0aW9uKCkgeyBzZWxmLmNvbm5lY3QoKSB9LCB0aGlzLl9hZHZpY2UuaW50ZXJ2YWwpO1xuICB9XG59KTtcblxuYXNzaWduKENsaWVudC5wcm90b3R5cGUsIERlZmVycmFibGUpO1xuYXNzaWduKENsaWVudC5wcm90b3R5cGUsIFB1Ymxpc2hlcik7XG5hc3NpZ24oQ2xpZW50LnByb3RvdHlwZSwgTG9nZ2luZyk7XG5hc3NpZ24oQ2xpZW50LnByb3RvdHlwZSwgRXh0ZW5zaWJsZSk7XG5cbm1vZHVsZS5leHBvcnRzID0gQ2xpZW50O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgQ2xhc3MgICAgID0gcmVxdWlyZSgnLi4vdXRpbC9jbGFzcycpLFxuICAgIFVSSSAgICAgICA9IHJlcXVpcmUoJy4uL3V0aWwvdXJpJyksXG4gICAgY29va2llcyAgID0gcmVxdWlyZSgnLi4vdXRpbC9jb29raWVzJyksXG4gICAgYXNzaWduICAgID0gcmVxdWlyZSgnLi4vdXRpbC9hc3NpZ24nKSxcbiAgICBMb2dnaW5nICAgPSByZXF1aXJlKCcuLi9taXhpbnMvbG9nZ2luZycpLFxuICAgIFB1Ymxpc2hlciA9IHJlcXVpcmUoJy4uL21peGlucy9wdWJsaXNoZXInKSxcbiAgICBUcmFuc3BvcnQgPSByZXF1aXJlKCcuLi90cmFuc3BvcnQnKSxcbiAgICBTY2hlZHVsZXIgPSByZXF1aXJlKCcuL3NjaGVkdWxlcicpO1xuXG52YXIgRGlzcGF0Y2hlciA9IENsYXNzKHsgY2xhc3NOYW1lOiAnRGlzcGF0Y2hlcicsXG4gIE1BWF9SRVFVRVNUX1NJWkU6IDIwNDgsXG4gIERFRkFVTFRfUkVUUlk6ICAgIDUsXG5cbiAgVVA6ICAgMSxcbiAgRE9XTjogMixcblxuICBpbml0aWFsaXplOiBmdW5jdGlvbihjbGllbnQsIGVuZHBvaW50LCBvcHRpb25zKSB7XG4gICAgdGhpcy5fY2xpZW50ICAgICA9IGNsaWVudDtcbiAgICB0aGlzLmVuZHBvaW50ICAgID0gVVJJLnBhcnNlKGVuZHBvaW50KTtcbiAgICB0aGlzLl9hbHRlcm5hdGVzID0gb3B0aW9ucy5lbmRwb2ludHMgfHwge307XG5cbiAgICB0aGlzLmNvb2tpZXMgICAgICA9IGNvb2tpZXMuQ29va2llSmFyICYmIG5ldyBjb29raWVzLkNvb2tpZUphcigpO1xuICAgIHRoaXMuX2Rpc2FibGVkICAgID0gW107XG4gICAgdGhpcy5fZW52ZWxvcGVzICAgPSB7fTtcbiAgICB0aGlzLmhlYWRlcnMgICAgICA9IHt9O1xuICAgIHRoaXMucmV0cnkgICAgICAgID0gb3B0aW9ucy5yZXRyeSB8fCB0aGlzLkRFRkFVTFRfUkVUUlk7XG4gICAgdGhpcy5fc2NoZWR1bGVyICAgPSBvcHRpb25zLnNjaGVkdWxlciB8fCBTY2hlZHVsZXI7XG4gICAgdGhpcy5fc3RhdGUgICAgICAgPSAwO1xuICAgIHRoaXMudHJhbnNwb3J0cyAgID0ge307XG4gICAgdGhpcy53c0V4dGVuc2lvbnMgPSBbXTtcblxuICAgIHRoaXMucHJveHkgPSBvcHRpb25zLnByb3h5IHx8IHt9O1xuICAgIGlmICh0eXBlb2YgdGhpcy5fcHJveHkgPT09ICdzdHJpbmcnKSB0aGlzLl9wcm94eSA9IHsgb3JpZ2luOiB0aGlzLl9wcm94eSB9O1xuXG4gICAgdmFyIGV4dHMgPSBvcHRpb25zLndlYnNvY2tldEV4dGVuc2lvbnM7XG4gICAgaWYgKGV4dHMpIHtcbiAgICAgIGV4dHMgPSBbXS5jb25jYXQoZXh0cyk7XG4gICAgICBmb3IgKHZhciBpID0gMCwgbiA9IGV4dHMubGVuZ3RoOyBpIDwgbjsgaSsrKVxuICAgICAgICB0aGlzLmFkZFdlYnNvY2tldEV4dGVuc2lvbihleHRzW2ldKTtcbiAgICB9XG5cbiAgICB0aGlzLnRscyA9IG9wdGlvbnMudGxzIHx8IHt9O1xuICAgIHRoaXMudGxzLmNhID0gdGhpcy50bHMuY2EgfHwgb3B0aW9ucy5jYTtcblxuICAgIGZvciAodmFyIHR5cGUgaW4gdGhpcy5fYWx0ZXJuYXRlcylcbiAgICAgIHRoaXMuX2FsdGVybmF0ZXNbdHlwZV0gPSBVUkkucGFyc2UodGhpcy5fYWx0ZXJuYXRlc1t0eXBlXSk7XG5cbiAgICB0aGlzLm1heFJlcXVlc3RTaXplID0gdGhpcy5NQVhfUkVRVUVTVF9TSVpFO1xuICB9LFxuXG4gIGVuZHBvaW50Rm9yOiBmdW5jdGlvbihjb25uZWN0aW9uVHlwZSkge1xuICAgIHJldHVybiB0aGlzLl9hbHRlcm5hdGVzW2Nvbm5lY3Rpb25UeXBlXSB8fCB0aGlzLmVuZHBvaW50O1xuICB9LFxuXG4gIGFkZFdlYnNvY2tldEV4dGVuc2lvbjogZnVuY3Rpb24oZXh0ZW5zaW9uKSB7XG4gICAgdGhpcy53c0V4dGVuc2lvbnMucHVzaChleHRlbnNpb24pO1xuICB9LFxuXG4gIGRpc2FibGU6IGZ1bmN0aW9uKGZlYXR1cmUpIHtcbiAgICB0aGlzLl9kaXNhYmxlZC5wdXNoKGZlYXR1cmUpO1xuICAgIFRyYW5zcG9ydC5kaXNhYmxlKGZlYXR1cmUpO1xuICB9LFxuXG4gIHNldEhlYWRlcjogZnVuY3Rpb24obmFtZSwgdmFsdWUpIHtcbiAgICB0aGlzLmhlYWRlcnNbbmFtZV0gPSB2YWx1ZTtcbiAgfSxcblxuICBjbG9zZTogZnVuY3Rpb24oKSB7XG4gICAgdmFyIHRyYW5zcG9ydCA9IHRoaXMuX3RyYW5zcG9ydDtcbiAgICBkZWxldGUgdGhpcy5fdHJhbnNwb3J0O1xuICAgIGlmICh0cmFuc3BvcnQpIHRyYW5zcG9ydC5jbG9zZSgpO1xuICB9LFxuXG4gIGdldENvbm5lY3Rpb25UeXBlczogZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIFRyYW5zcG9ydC5nZXRDb25uZWN0aW9uVHlwZXMoKTtcbiAgfSxcblxuICBzZWxlY3RUcmFuc3BvcnQ6IGZ1bmN0aW9uKHRyYW5zcG9ydFR5cGVzKSB7XG4gICAgVHJhbnNwb3J0LmdldCh0aGlzLCB0cmFuc3BvcnRUeXBlcywgdGhpcy5fZGlzYWJsZWQsIGZ1bmN0aW9uKHRyYW5zcG9ydCkge1xuICAgICAgdGhpcy5kZWJ1ZygnU2VsZWN0ZWQgPyB0cmFuc3BvcnQgZm9yID8nLCB0cmFuc3BvcnQuY29ubmVjdGlvblR5cGUsIHRyYW5zcG9ydC5lbmRwb2ludC5ocmVmKTtcblxuICAgICAgaWYgKHRyYW5zcG9ydCA9PT0gdGhpcy5fdHJhbnNwb3J0KSByZXR1cm47XG4gICAgICBpZiAodGhpcy5fdHJhbnNwb3J0KSB0aGlzLl90cmFuc3BvcnQuY2xvc2UoKTtcblxuICAgICAgdGhpcy5fdHJhbnNwb3J0ID0gdHJhbnNwb3J0O1xuICAgICAgdGhpcy5jb25uZWN0aW9uVHlwZSA9IHRyYW5zcG9ydC5jb25uZWN0aW9uVHlwZTtcbiAgICB9LCB0aGlzKTtcbiAgfSxcblxuICBzZW5kTWVzc2FnZTogZnVuY3Rpb24obWVzc2FnZSwgdGltZW91dCwgb3B0aW9ucykge1xuICAgIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuXG4gICAgdmFyIGlkICAgICAgID0gbWVzc2FnZS5pZCxcbiAgICAgICAgYXR0ZW1wdHMgPSBvcHRpb25zLmF0dGVtcHRzLFxuICAgICAgICBkZWFkbGluZSA9IG9wdGlvbnMuZGVhZGxpbmUgJiYgbmV3IERhdGUoKS5nZXRUaW1lKCkgKyAob3B0aW9ucy5kZWFkbGluZSAqIDEwMDApLFxuICAgICAgICBlbnZlbG9wZSA9IHRoaXMuX2VudmVsb3Blc1tpZF0sXG4gICAgICAgIHNjaGVkdWxlcjtcblxuICAgIGlmICghZW52ZWxvcGUpIHtcbiAgICAgIHNjaGVkdWxlciA9IG5ldyB0aGlzLl9zY2hlZHVsZXIobWVzc2FnZSwgeyB0aW1lb3V0OiB0aW1lb3V0LCBpbnRlcnZhbDogdGhpcy5yZXRyeSwgYXR0ZW1wdHM6IGF0dGVtcHRzLCBkZWFkbGluZTogZGVhZGxpbmUgfSk7XG4gICAgICBlbnZlbG9wZSAgPSB0aGlzLl9lbnZlbG9wZXNbaWRdID0geyBtZXNzYWdlOiBtZXNzYWdlLCBzY2hlZHVsZXI6IHNjaGVkdWxlciB9O1xuICAgIH1cblxuICAgIHRoaXMuX3NlbmRFbnZlbG9wZShlbnZlbG9wZSk7XG4gIH0sXG5cbiAgX3NlbmRFbnZlbG9wZTogZnVuY3Rpb24oZW52ZWxvcGUpIHtcbiAgICBpZiAoIXRoaXMuX3RyYW5zcG9ydCkgcmV0dXJuO1xuICAgIGlmIChlbnZlbG9wZS5yZXF1ZXN0IHx8IGVudmVsb3BlLnRpbWVyKSByZXR1cm47XG5cbiAgICB2YXIgbWVzc2FnZSAgID0gZW52ZWxvcGUubWVzc2FnZSxcbiAgICAgICAgc2NoZWR1bGVyID0gZW52ZWxvcGUuc2NoZWR1bGVyLFxuICAgICAgICBzZWxmICAgICAgPSB0aGlzO1xuXG4gICAgaWYgKCFzY2hlZHVsZXIuaXNEZWxpdmVyYWJsZSgpKSB7XG4gICAgICBzY2hlZHVsZXIuYWJvcnQoKTtcbiAgICAgIGRlbGV0ZSB0aGlzLl9lbnZlbG9wZXNbbWVzc2FnZS5pZF07XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgZW52ZWxvcGUudGltZXIgPSBnbG9iYWwuc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgIHNlbGYuaGFuZGxlRXJyb3IobWVzc2FnZSk7XG4gICAgfSwgc2NoZWR1bGVyLmdldFRpbWVvdXQoKSAqIDEwMDApO1xuXG4gICAgc2NoZWR1bGVyLnNlbmQoKTtcbiAgICBlbnZlbG9wZS5yZXF1ZXN0ID0gdGhpcy5fdHJhbnNwb3J0LnNlbmRNZXNzYWdlKG1lc3NhZ2UpO1xuICB9LFxuXG4gIGhhbmRsZVJlc3BvbnNlOiBmdW5jdGlvbihyZXBseSkge1xuICAgIHZhciBlbnZlbG9wZSA9IHRoaXMuX2VudmVsb3Blc1tyZXBseS5pZF07XG5cbiAgICBpZiAocmVwbHkuc3VjY2Vzc2Z1bCAhPT0gdW5kZWZpbmVkICYmIGVudmVsb3BlKSB7XG4gICAgICBlbnZlbG9wZS5zY2hlZHVsZXIuc3VjY2VlZCgpO1xuICAgICAgZGVsZXRlIHRoaXMuX2VudmVsb3Blc1tyZXBseS5pZF07XG4gICAgICBnbG9iYWwuY2xlYXJUaW1lb3V0KGVudmVsb3BlLnRpbWVyKTtcbiAgICB9XG5cbiAgICB0aGlzLnRyaWdnZXIoJ21lc3NhZ2UnLCByZXBseSk7XG5cbiAgICBpZiAodGhpcy5fc3RhdGUgPT09IHRoaXMuVVApIHJldHVybjtcbiAgICB0aGlzLl9zdGF0ZSA9IHRoaXMuVVA7XG4gICAgdGhpcy5fY2xpZW50LnRyaWdnZXIoJ3RyYW5zcG9ydDp1cCcpO1xuICB9LFxuXG4gIGhhbmRsZUVycm9yOiBmdW5jdGlvbihtZXNzYWdlLCBpbW1lZGlhdGUpIHtcbiAgICB2YXIgZW52ZWxvcGUgPSB0aGlzLl9lbnZlbG9wZXNbbWVzc2FnZS5pZF0sXG4gICAgICAgIHJlcXVlc3QgID0gZW52ZWxvcGUgJiYgZW52ZWxvcGUucmVxdWVzdCxcbiAgICAgICAgc2VsZiAgICAgPSB0aGlzO1xuXG4gICAgaWYgKCFyZXF1ZXN0KSByZXR1cm47XG5cbiAgICByZXF1ZXN0LnRoZW4oZnVuY3Rpb24ocmVxKSB7XG4gICAgICBpZiAocmVxICYmIHJlcS5hYm9ydCkgcmVxLmFib3J0KCk7XG4gICAgfSk7XG5cbiAgICB2YXIgc2NoZWR1bGVyID0gZW52ZWxvcGUuc2NoZWR1bGVyO1xuICAgIHNjaGVkdWxlci5mYWlsKCk7XG5cbiAgICBnbG9iYWwuY2xlYXJUaW1lb3V0KGVudmVsb3BlLnRpbWVyKTtcbiAgICBlbnZlbG9wZS5yZXF1ZXN0ID0gZW52ZWxvcGUudGltZXIgPSBudWxsO1xuXG4gICAgaWYgKGltbWVkaWF0ZSkge1xuICAgICAgdGhpcy5fc2VuZEVudmVsb3BlKGVudmVsb3BlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgZW52ZWxvcGUudGltZXIgPSBnbG9iYWwuc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgZW52ZWxvcGUudGltZXIgPSBudWxsO1xuICAgICAgICBzZWxmLl9zZW5kRW52ZWxvcGUoZW52ZWxvcGUpO1xuICAgICAgfSwgc2NoZWR1bGVyLmdldEludGVydmFsKCkgKiAxMDAwKTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5fc3RhdGUgPT09IHRoaXMuRE9XTikgcmV0dXJuO1xuICAgIHRoaXMuX3N0YXRlID0gdGhpcy5ET1dOO1xuICAgIHRoaXMuX2NsaWVudC50cmlnZ2VyKCd0cmFuc3BvcnQ6ZG93bicpO1xuICB9XG59KTtcblxuRGlzcGF0Y2hlci5jcmVhdGUgPSBmdW5jdGlvbihjbGllbnQsIGVuZHBvaW50LCBvcHRpb25zKSB7XG4gIHJldHVybiBuZXcgRGlzcGF0Y2hlcihjbGllbnQsIGVuZHBvaW50LCBvcHRpb25zKTtcbn07XG5cbmFzc2lnbihEaXNwYXRjaGVyLnByb3RvdHlwZSwgUHVibGlzaGVyKTtcbmFzc2lnbihEaXNwYXRjaGVyLnByb3RvdHlwZSwgTG9nZ2luZyk7XG5cbm1vZHVsZS5leHBvcnRzID0gRGlzcGF0Y2hlcjtcbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIENsYXNzICAgPSByZXF1aXJlKCcuLi91dGlsL2NsYXNzJyksXG4gICAgR3JhbW1hciA9IHJlcXVpcmUoJy4vZ3JhbW1hcicpO1xuXG52YXIgRXJyb3IgPSBDbGFzcyh7XG4gIGluaXRpYWxpemU6IGZ1bmN0aW9uKGNvZGUsIHBhcmFtcywgbWVzc2FnZSkge1xuICAgIHRoaXMuY29kZSAgICA9IGNvZGU7XG4gICAgdGhpcy5wYXJhbXMgID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwocGFyYW1zKTtcbiAgICB0aGlzLm1lc3NhZ2UgPSBtZXNzYWdlO1xuICB9LFxuXG4gIHRvU3RyaW5nOiBmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdGhpcy5jb2RlICsgJzonICtcbiAgICAgICAgICAgdGhpcy5wYXJhbXMuam9pbignLCcpICsgJzonICtcbiAgICAgICAgICAgdGhpcy5tZXNzYWdlO1xuICB9XG59KTtcblxuRXJyb3IucGFyc2UgPSBmdW5jdGlvbihtZXNzYWdlKSB7XG4gIG1lc3NhZ2UgPSBtZXNzYWdlIHx8ICcnO1xuICBpZiAoIUdyYW1tYXIuRVJST1IudGVzdChtZXNzYWdlKSkgcmV0dXJuIG5ldyBFcnJvcihudWxsLCBbXSwgbWVzc2FnZSk7XG5cbiAgdmFyIHBhcnRzICAgPSBtZXNzYWdlLnNwbGl0KCc6JyksXG4gICAgICBjb2RlICAgID0gcGFyc2VJbnQocGFydHNbMF0pLFxuICAgICAgcGFyYW1zICA9IHBhcnRzWzFdLnNwbGl0KCcsJyksXG4gICAgICBtZXNzYWdlID0gcGFydHNbMl07XG5cbiAgcmV0dXJuIG5ldyBFcnJvcihjb2RlLCBwYXJhbXMsIG1lc3NhZ2UpO1xufTtcblxuLy8gaHR0cDovL2NvZGUuZ29vZ2xlLmNvbS9wL2NvbWV0ZC93aWtpL0JheWV1eENvZGVzXG52YXIgZXJyb3JzID0ge1xuICB2ZXJzaW9uTWlzbWF0Y2g6ICBbMzAwLCAnVmVyc2lvbiBtaXNtYXRjaCddLFxuICBjb25udHlwZU1pc21hdGNoOiBbMzAxLCAnQ29ubmVjdGlvbiB0eXBlcyBub3Qgc3VwcG9ydGVkJ10sXG4gIGV4dE1pc21hdGNoOiAgICAgIFszMDIsICdFeHRlbnNpb24gbWlzbWF0Y2gnXSxcbiAgYmFkUmVxdWVzdDogICAgICAgWzQwMCwgJ0JhZCByZXF1ZXN0J10sXG4gIGNsaWVudFVua25vd246ICAgIFs0MDEsICdVbmtub3duIGNsaWVudCddLFxuICBwYXJhbWV0ZXJNaXNzaW5nOiBbNDAyLCAnTWlzc2luZyByZXF1aXJlZCBwYXJhbWV0ZXInXSxcbiAgY2hhbm5lbEZvcmJpZGRlbjogWzQwMywgJ0ZvcmJpZGRlbiBjaGFubmVsJ10sXG4gIGNoYW5uZWxVbmtub3duOiAgIFs0MDQsICdVbmtub3duIGNoYW5uZWwnXSxcbiAgY2hhbm5lbEludmFsaWQ6ICAgWzQwNSwgJ0ludmFsaWQgY2hhbm5lbCddLFxuICBleHRVbmtub3duOiAgICAgICBbNDA2LCAnVW5rbm93biBleHRlbnNpb24nXSxcbiAgcHVibGlzaEZhaWxlZDogICAgWzQwNywgJ0ZhaWxlZCB0byBwdWJsaXNoJ10sXG4gIHNlcnZlckVycm9yOiAgICAgIFs1MDAsICdJbnRlcm5hbCBzZXJ2ZXIgZXJyb3InXVxufTtcblxuZm9yICh2YXIgbmFtZSBpbiBlcnJvcnMpXG4gIChmdW5jdGlvbihuYW1lKSB7XG4gICAgRXJyb3JbbmFtZV0gPSBmdW5jdGlvbigpIHtcbiAgICAgIHJldHVybiBuZXcgRXJyb3IoZXJyb3JzW25hbWVdWzBdLCBhcmd1bWVudHMsIGVycm9yc1tuYW1lXVsxXSkudG9TdHJpbmcoKTtcbiAgICB9O1xuICB9KShuYW1lKTtcblxubW9kdWxlLmV4cG9ydHMgPSBFcnJvcjtcbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIGFzc2lnbiAgPSByZXF1aXJlKCcuLi91dGlsL2Fzc2lnbicpLFxuICAgIExvZ2dpbmcgPSByZXF1aXJlKCcuLi9taXhpbnMvbG9nZ2luZycpO1xuXG52YXIgRXh0ZW5zaWJsZSA9IHtcbiAgYWRkRXh0ZW5zaW9uOiBmdW5jdGlvbihleHRlbnNpb24pIHtcbiAgICB0aGlzLl9leHRlbnNpb25zID0gdGhpcy5fZXh0ZW5zaW9ucyB8fCBbXTtcbiAgICB0aGlzLl9leHRlbnNpb25zLnB1c2goZXh0ZW5zaW9uKTtcbiAgICBpZiAoZXh0ZW5zaW9uLmFkZGVkKSBleHRlbnNpb24uYWRkZWQodGhpcyk7XG4gIH0sXG5cbiAgcmVtb3ZlRXh0ZW5zaW9uOiBmdW5jdGlvbihleHRlbnNpb24pIHtcbiAgICBpZiAoIXRoaXMuX2V4dGVuc2lvbnMpIHJldHVybjtcbiAgICB2YXIgaSA9IHRoaXMuX2V4dGVuc2lvbnMubGVuZ3RoO1xuICAgIHdoaWxlIChpLS0pIHtcbiAgICAgIGlmICh0aGlzLl9leHRlbnNpb25zW2ldICE9PSBleHRlbnNpb24pIGNvbnRpbnVlO1xuICAgICAgdGhpcy5fZXh0ZW5zaW9ucy5zcGxpY2UoaSwxKTtcbiAgICAgIGlmIChleHRlbnNpb24ucmVtb3ZlZCkgZXh0ZW5zaW9uLnJlbW92ZWQodGhpcyk7XG4gICAgfVxuICB9LFxuXG4gIHBpcGVUaHJvdWdoRXh0ZW5zaW9uczogZnVuY3Rpb24oc3RhZ2UsIG1lc3NhZ2UsIHJlcXVlc3QsIGNhbGxiYWNrLCBjb250ZXh0KSB7XG4gICAgdGhpcy5kZWJ1ZygnUGFzc2luZyB0aHJvdWdoID8gZXh0ZW5zaW9uczogPycsIHN0YWdlLCBtZXNzYWdlKTtcblxuICAgIGlmICghdGhpcy5fZXh0ZW5zaW9ucykgcmV0dXJuIGNhbGxiYWNrLmNhbGwoY29udGV4dCwgbWVzc2FnZSk7XG4gICAgdmFyIGV4dGVuc2lvbnMgPSB0aGlzLl9leHRlbnNpb25zLnNsaWNlKCk7XG5cbiAgICB2YXIgcGlwZSA9IGZ1bmN0aW9uKG1lc3NhZ2UpIHtcbiAgICAgIGlmICghbWVzc2FnZSkgcmV0dXJuIGNhbGxiYWNrLmNhbGwoY29udGV4dCwgbWVzc2FnZSk7XG5cbiAgICAgIHZhciBleHRlbnNpb24gPSBleHRlbnNpb25zLnNoaWZ0KCk7XG4gICAgICBpZiAoIWV4dGVuc2lvbikgcmV0dXJuIGNhbGxiYWNrLmNhbGwoY29udGV4dCwgbWVzc2FnZSk7XG5cbiAgICAgIHZhciBmbiA9IGV4dGVuc2lvbltzdGFnZV07XG4gICAgICBpZiAoIWZuKSByZXR1cm4gcGlwZShtZXNzYWdlKTtcblxuICAgICAgaWYgKGZuLmxlbmd0aCA+PSAzKSBleHRlbnNpb25bc3RhZ2VdKG1lc3NhZ2UsIHJlcXVlc3QsIHBpcGUpO1xuICAgICAgZWxzZSAgICAgICAgICAgICAgICBleHRlbnNpb25bc3RhZ2VdKG1lc3NhZ2UsIHBpcGUpO1xuICAgIH07XG4gICAgcGlwZShtZXNzYWdlKTtcbiAgfVxufTtcblxuYXNzaWduKEV4dGVuc2libGUsIExvZ2dpbmcpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IEV4dGVuc2libGU7XG4iLCIndXNlIHN0cmljdCc7XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICBDSEFOTkVMX05BTUU6ICAgICAvXlxcLygoKChbYS16XXxbQS1aXSl8WzAtOV0pfChcXC18XFxffFxcIXxcXH58XFwofFxcKXxcXCR8XFxAKSkpKyhcXC8oKCgoW2Etel18W0EtWl0pfFswLTldKXwoXFwtfFxcX3xcXCF8XFx+fFxcKHxcXCl8XFwkfFxcQCkpKSspKiQvLFxuICBDSEFOTkVMX1BBVFRFUk46ICAvXihcXC8oKCgoW2Etel18W0EtWl0pfFswLTldKXwoXFwtfFxcX3xcXCF8XFx+fFxcKHxcXCl8XFwkfFxcQCkpKSspKlxcL1xcKnsxLDJ9JC8sXG4gIEVSUk9SOiAgICAgICAgICAgIC9eKFswLTldWzAtOV1bMC05XTooKCgoW2Etel18W0EtWl0pfFswLTldKXwoXFwtfFxcX3xcXCF8XFx+fFxcKHxcXCl8XFwkfFxcQCl8IHxcXC98XFwqfFxcLikpKigsKCgoKFthLXpdfFtBLVpdKXxbMC05XSl8KFxcLXxcXF98XFwhfFxcfnxcXCh8XFwpfFxcJHxcXEApfCB8XFwvfFxcKnxcXC4pKSopKjooKCgoW2Etel18W0EtWl0pfFswLTldKXwoXFwtfFxcX3xcXCF8XFx+fFxcKHxcXCl8XFwkfFxcQCl8IHxcXC98XFwqfFxcLikpKnxbMC05XVswLTldWzAtOV06OigoKChbYS16XXxbQS1aXSl8WzAtOV0pfChcXC18XFxffFxcIXxcXH58XFwofFxcKXxcXCR8XFxAKXwgfFxcL3xcXCp8XFwuKSkqKSQvLFxuICBWRVJTSU9OOiAgICAgICAgICAvXihbMC05XSkrKFxcLigoW2Etel18W0EtWl0pfFswLTldKSgoKChbYS16XXxbQS1aXSl8WzAtOV0pfFxcLXxcXF8pKSopKiQvXG59O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgQ2xhc3MgICAgICA9IHJlcXVpcmUoJy4uL3V0aWwvY2xhc3MnKSxcbiAgICBEZWZlcnJhYmxlID0gcmVxdWlyZSgnLi4vbWl4aW5zL2RlZmVycmFibGUnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBDbGFzcyhEZWZlcnJhYmxlKTtcbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIGFzc2lnbiA9IHJlcXVpcmUoJy4uL3V0aWwvYXNzaWduJyk7XG5cbnZhciBTY2hlZHVsZXIgPSBmdW5jdGlvbihtZXNzYWdlLCBvcHRpb25zKSB7XG4gIHRoaXMubWVzc2FnZSAgPSBtZXNzYWdlO1xuICB0aGlzLm9wdGlvbnMgID0gb3B0aW9ucztcbiAgdGhpcy5hdHRlbXB0cyA9IDA7XG59O1xuXG5hc3NpZ24oU2NoZWR1bGVyLnByb3RvdHlwZSwge1xuICBnZXRUaW1lb3V0OiBmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdGhpcy5vcHRpb25zLnRpbWVvdXQ7XG4gIH0sXG5cbiAgZ2V0SW50ZXJ2YWw6IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiB0aGlzLm9wdGlvbnMuaW50ZXJ2YWw7XG4gIH0sXG5cbiAgaXNEZWxpdmVyYWJsZTogZnVuY3Rpb24oKSB7XG4gICAgdmFyIGF0dGVtcHRzID0gdGhpcy5vcHRpb25zLmF0dGVtcHRzLFxuICAgICAgICBtYWRlICAgICA9IHRoaXMuYXR0ZW1wdHMsXG4gICAgICAgIGRlYWRsaW5lID0gdGhpcy5vcHRpb25zLmRlYWRsaW5lLFxuICAgICAgICBub3cgICAgICA9IG5ldyBEYXRlKCkuZ2V0VGltZSgpO1xuXG4gICAgaWYgKGF0dGVtcHRzICE9PSB1bmRlZmluZWQgJiYgbWFkZSA+PSBhdHRlbXB0cylcbiAgICAgIHJldHVybiBmYWxzZTtcblxuICAgIGlmIChkZWFkbGluZSAhPT0gdW5kZWZpbmVkICYmIG5vdyA+IGRlYWRsaW5lKVxuICAgICAgcmV0dXJuIGZhbHNlO1xuXG4gICAgcmV0dXJuIHRydWU7XG4gIH0sXG5cbiAgc2VuZDogZnVuY3Rpb24oKSB7XG4gICAgdGhpcy5hdHRlbXB0cyArPSAxO1xuICB9LFxuXG4gIHN1Y2NlZWQ6IGZ1bmN0aW9uKCkge30sXG5cbiAgZmFpbDogZnVuY3Rpb24oKSB7fSxcblxuICBhYm9ydDogZnVuY3Rpb24oKSB7fVxufSk7XG5cbm1vZHVsZS5leHBvcnRzID0gU2NoZWR1bGVyO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgQ2xhc3MgICAgICA9IHJlcXVpcmUoJy4uL3V0aWwvY2xhc3MnKSxcbiAgICBhc3NpZ24gICAgID0gcmVxdWlyZSgnLi4vdXRpbC9hc3NpZ24nKSxcbiAgICBEZWZlcnJhYmxlID0gcmVxdWlyZSgnLi4vbWl4aW5zL2RlZmVycmFibGUnKTtcblxudmFyIFN1YnNjcmlwdGlvbiA9IENsYXNzKHtcbiAgaW5pdGlhbGl6ZTogZnVuY3Rpb24oY2xpZW50LCBjaGFubmVscywgY2FsbGJhY2ssIGNvbnRleHQpIHtcbiAgICB0aGlzLl9jbGllbnQgICAgPSBjbGllbnQ7XG4gICAgdGhpcy5fY2hhbm5lbHMgID0gY2hhbm5lbHM7XG4gICAgdGhpcy5fY2FsbGJhY2sgID0gY2FsbGJhY2s7XG4gICAgdGhpcy5fY29udGV4dCAgID0gY29udGV4dDtcbiAgICB0aGlzLl9jYW5jZWxsZWQgPSBmYWxzZTtcbiAgfSxcblxuICB3aXRoQ2hhbm5lbDogZnVuY3Rpb24oY2FsbGJhY2ssIGNvbnRleHQpIHtcbiAgICB0aGlzLl93aXRoQ2hhbm5lbCA9IFtjYWxsYmFjaywgY29udGV4dF07XG4gICAgcmV0dXJuIHRoaXM7XG4gIH0sXG5cbiAgYXBwbHk6IGZ1bmN0aW9uKGNvbnRleHQsIGFyZ3MpIHtcbiAgICB2YXIgbWVzc2FnZSA9IGFyZ3NbMF07XG5cbiAgICBpZiAodGhpcy5fY2FsbGJhY2spXG4gICAgICB0aGlzLl9jYWxsYmFjay5jYWxsKHRoaXMuX2NvbnRleHQsIG1lc3NhZ2UuZGF0YSk7XG5cbiAgICBpZiAodGhpcy5fd2l0aENoYW5uZWwpXG4gICAgICB0aGlzLl93aXRoQ2hhbm5lbFswXS5jYWxsKHRoaXMuX3dpdGhDaGFubmVsWzFdLCBtZXNzYWdlLmNoYW5uZWwsIG1lc3NhZ2UuZGF0YSk7XG4gIH0sXG5cbiAgY2FuY2VsOiBmdW5jdGlvbigpIHtcbiAgICBpZiAodGhpcy5fY2FuY2VsbGVkKSByZXR1cm47XG4gICAgdGhpcy5fY2xpZW50LnVuc3Vic2NyaWJlKHRoaXMuX2NoYW5uZWxzLCB0aGlzKTtcbiAgICB0aGlzLl9jYW5jZWxsZWQgPSB0cnVlO1xuICB9LFxuXG4gIHVuc3Vic2NyaWJlOiBmdW5jdGlvbigpIHtcbiAgICB0aGlzLmNhbmNlbCgpO1xuICB9XG59KTtcblxuYXNzaWduKFN1YnNjcmlwdGlvbi5wcm90b3R5cGUsIERlZmVycmFibGUpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IFN1YnNjcmlwdGlvbjtcbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIFRyYW5zcG9ydCA9IHJlcXVpcmUoJy4vdHJhbnNwb3J0Jyk7XG5cblRyYW5zcG9ydC5yZWdpc3Rlcignd2Vic29ja2V0JywgcmVxdWlyZSgnLi93ZWJfc29ja2V0JykpO1xuVHJhbnNwb3J0LnJlZ2lzdGVyKCdldmVudHNvdXJjZScsIHJlcXVpcmUoJy4vZXZlbnRfc291cmNlJykpO1xuVHJhbnNwb3J0LnJlZ2lzdGVyKCdsb25nLXBvbGxpbmcnLCByZXF1aXJlKCcuL3hocicpKTtcblRyYW5zcG9ydC5yZWdpc3RlcignY3Jvc3Mtb3JpZ2luLWxvbmctcG9sbGluZycsIHJlcXVpcmUoJy4vY29ycycpKTtcblRyYW5zcG9ydC5yZWdpc3RlcignY2FsbGJhY2stcG9sbGluZycsIHJlcXVpcmUoJy4vanNvbnAnKSk7XG5cbm1vZHVsZS5leHBvcnRzID0gVHJhbnNwb3J0O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgQ2xhc3MgICAgID0gcmVxdWlyZSgnLi4vdXRpbC9jbGFzcycpLFxuICAgIFNldCAgICAgICA9IHJlcXVpcmUoJy4uL3V0aWwvc2V0JyksXG4gICAgVVJJICAgICAgID0gcmVxdWlyZSgnLi4vdXRpbC91cmknKSxcbiAgICBhc3NpZ24gICAgPSByZXF1aXJlKCcuLi91dGlsL2Fzc2lnbicpLFxuICAgIHRvSlNPTiAgICA9IHJlcXVpcmUoJy4uL3V0aWwvdG9fanNvbicpLFxuICAgIFRyYW5zcG9ydCA9IHJlcXVpcmUoJy4vdHJhbnNwb3J0Jyk7XG5cbnZhciBDT1JTID0gYXNzaWduKENsYXNzKFRyYW5zcG9ydCwge1xuICBlbmNvZGU6IGZ1bmN0aW9uKG1lc3NhZ2VzKSB7XG4gICAgcmV0dXJuICdtZXNzYWdlPScgKyBlbmNvZGVVUklDb21wb25lbnQodG9KU09OKG1lc3NhZ2VzKSk7XG4gIH0sXG5cbiAgcmVxdWVzdDogZnVuY3Rpb24obWVzc2FnZXMpIHtcbiAgICB2YXIgeGhyQ2xhc3MgPSBnbG9iYWwuWERvbWFpblJlcXVlc3QgPyBYRG9tYWluUmVxdWVzdCA6IFhNTEh0dHBSZXF1ZXN0LFxuICAgICAgICB4aHIgICAgICA9IG5ldyB4aHJDbGFzcygpLFxuICAgICAgICBpZCAgICAgICA9ICsrQ09SUy5faWQsXG4gICAgICAgIGhlYWRlcnMgID0gdGhpcy5fZGlzcGF0Y2hlci5oZWFkZXJzLFxuICAgICAgICBzZWxmICAgICA9IHRoaXMsXG4gICAgICAgIGtleTtcblxuICAgIHhoci5vcGVuKCdQT1NUJywgdGhpcy5lbmRwb2ludC5ocmVmLCB0cnVlKTtcbiAgICB4aHIud2l0aENyZWRlbnRpYWxzID0gdHJ1ZTtcblxuICAgIGlmICh4aHIuc2V0UmVxdWVzdEhlYWRlcikge1xuICAgICAgeGhyLnNldFJlcXVlc3RIZWFkZXIoJ1ByYWdtYScsICduby1jYWNoZScpO1xuICAgICAgZm9yIChrZXkgaW4gaGVhZGVycykge1xuICAgICAgICBpZiAoIWhlYWRlcnMuaGFzT3duUHJvcGVydHkoa2V5KSkgY29udGludWU7XG4gICAgICAgIHhoci5zZXRSZXF1ZXN0SGVhZGVyKGtleSwgaGVhZGVyc1trZXldKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB2YXIgY2xlYW5VcCA9IGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKCF4aHIpIHJldHVybiBmYWxzZTtcbiAgICAgIENPUlMuX3BlbmRpbmcucmVtb3ZlKGlkKTtcbiAgICAgIHhoci5vbmxvYWQgPSB4aHIub25lcnJvciA9IHhoci5vbnRpbWVvdXQgPSB4aHIub25wcm9ncmVzcyA9IG51bGw7XG4gICAgICB4aHIgPSBudWxsO1xuICAgIH07XG5cbiAgICB4aHIub25sb2FkID0gZnVuY3Rpb24oKSB7XG4gICAgICB2YXIgcmVwbGllcztcbiAgICAgIHRyeSB7IHJlcGxpZXMgPSBKU09OLnBhcnNlKHhoci5yZXNwb25zZVRleHQpIH0gY2F0Y2ggKGVycm9yKSB7fVxuXG4gICAgICBjbGVhblVwKCk7XG5cbiAgICAgIGlmIChyZXBsaWVzKVxuICAgICAgICBzZWxmLl9yZWNlaXZlKHJlcGxpZXMpO1xuICAgICAgZWxzZVxuICAgICAgICBzZWxmLl9oYW5kbGVFcnJvcihtZXNzYWdlcyk7XG4gICAgfTtcblxuICAgIHhoci5vbmVycm9yID0geGhyLm9udGltZW91dCA9IGZ1bmN0aW9uKCkge1xuICAgICAgY2xlYW5VcCgpO1xuICAgICAgc2VsZi5faGFuZGxlRXJyb3IobWVzc2FnZXMpO1xuICAgIH07XG5cbiAgICB4aHIub25wcm9ncmVzcyA9IGZ1bmN0aW9uKCkge307XG5cbiAgICBpZiAoeGhyQ2xhc3MgPT09IGdsb2JhbC5YRG9tYWluUmVxdWVzdClcbiAgICAgIENPUlMuX3BlbmRpbmcuYWRkKHsgaWQ6IGlkLCB4aHI6IHhociB9KTtcblxuICAgIHhoci5zZW5kKHRoaXMuZW5jb2RlKG1lc3NhZ2VzKSk7XG4gICAgcmV0dXJuIHhocjtcbiAgfVxufSksIHtcbiAgX2lkOiAgICAgIDAsXG4gIF9wZW5kaW5nOiBuZXcgU2V0KCksXG5cbiAgaXNVc2FibGU6IGZ1bmN0aW9uKGRpc3BhdGNoZXIsIGVuZHBvaW50LCBjYWxsYmFjaywgY29udGV4dCkge1xuICAgIGlmIChVUkkuaXNTYW1lT3JpZ2luKGVuZHBvaW50KSlcbiAgICAgIHJldHVybiBjYWxsYmFjay5jYWxsKGNvbnRleHQsIGZhbHNlKTtcblxuICAgIGlmIChnbG9iYWwuWERvbWFpblJlcXVlc3QpXG4gICAgICByZXR1cm4gY2FsbGJhY2suY2FsbChjb250ZXh0LCBlbmRwb2ludC5wcm90b2NvbCA9PT0gbG9jYXRpb24ucHJvdG9jb2wpO1xuXG4gICAgaWYgKGdsb2JhbC5YTUxIdHRwUmVxdWVzdCkge1xuICAgICAgdmFyIHhociA9IG5ldyBYTUxIdHRwUmVxdWVzdCgpO1xuICAgICAgcmV0dXJuIGNhbGxiYWNrLmNhbGwoY29udGV4dCwgeGhyLndpdGhDcmVkZW50aWFscyAhPT0gdW5kZWZpbmVkKTtcbiAgICB9XG4gICAgcmV0dXJuIGNhbGxiYWNrLmNhbGwoY29udGV4dCwgZmFsc2UpO1xuICB9XG59KTtcblxubW9kdWxlLmV4cG9ydHMgPSBDT1JTO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgQ2xhc3MgICAgICA9IHJlcXVpcmUoJy4uL3V0aWwvY2xhc3MnKSxcbiAgICBVUkkgICAgICAgID0gcmVxdWlyZSgnLi4vdXRpbC91cmknKSxcbiAgICBjb3B5T2JqZWN0ID0gcmVxdWlyZSgnLi4vdXRpbC9jb3B5X29iamVjdCcpLFxuICAgIGFzc2lnbiAgICAgPSByZXF1aXJlKCcuLi91dGlsL2Fzc2lnbicpLFxuICAgIERlZmVycmFibGUgPSByZXF1aXJlKCcuLi9taXhpbnMvZGVmZXJyYWJsZScpLFxuICAgIFRyYW5zcG9ydCAgPSByZXF1aXJlKCcuL3RyYW5zcG9ydCcpLFxuICAgIFhIUiAgICAgICAgPSByZXF1aXJlKCcuL3hocicpO1xuXG52YXIgRXZlbnRTb3VyY2UgPSBhc3NpZ24oQ2xhc3MoVHJhbnNwb3J0LCB7XG4gIGluaXRpYWxpemU6IGZ1bmN0aW9uKGRpc3BhdGNoZXIsIGVuZHBvaW50KSB7XG4gICAgVHJhbnNwb3J0LnByb3RvdHlwZS5pbml0aWFsaXplLmNhbGwodGhpcywgZGlzcGF0Y2hlciwgZW5kcG9pbnQpO1xuICAgIGlmICghZ2xvYmFsLkV2ZW50U291cmNlKSByZXR1cm4gdGhpcy5zZXREZWZlcnJlZFN0YXR1cygnZmFpbGVkJyk7XG5cbiAgICB0aGlzLl94aHIgPSBuZXcgWEhSKGRpc3BhdGNoZXIsIGVuZHBvaW50KTtcblxuICAgIGVuZHBvaW50ID0gY29weU9iamVjdChlbmRwb2ludCk7XG4gICAgZW5kcG9pbnQucGF0aG5hbWUgKz0gJy8nICsgZGlzcGF0Y2hlci5jbGllbnRJZDtcblxuICAgIHZhciBzb2NrZXQgPSBuZXcgZ2xvYmFsLkV2ZW50U291cmNlKFVSSS5zdHJpbmdpZnkoZW5kcG9pbnQpKSxcbiAgICAgICAgc2VsZiAgID0gdGhpcztcblxuICAgIHNvY2tldC5vbm9wZW4gPSBmdW5jdGlvbigpIHtcbiAgICAgIHNlbGYuX2V2ZXJDb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgc2VsZi5zZXREZWZlcnJlZFN0YXR1cygnc3VjY2VlZGVkJyk7XG4gICAgfTtcblxuICAgIHNvY2tldC5vbmVycm9yID0gZnVuY3Rpb24oKSB7XG4gICAgICBpZiAoc2VsZi5fZXZlckNvbm5lY3RlZCkge1xuICAgICAgICBzZWxmLl9oYW5kbGVFcnJvcihbXSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZWxmLnNldERlZmVycmVkU3RhdHVzKCdmYWlsZWQnKTtcbiAgICAgICAgc29ja2V0LmNsb3NlKCk7XG4gICAgICB9XG4gICAgfTtcblxuICAgIHNvY2tldC5vbm1lc3NhZ2UgPSBmdW5jdGlvbihldmVudCkge1xuICAgICAgdmFyIHJlcGxpZXM7XG4gICAgICB0cnkgeyByZXBsaWVzID0gSlNPTi5wYXJzZShldmVudC5kYXRhKSB9IGNhdGNoIChlcnJvcikge31cblxuICAgICAgaWYgKHJlcGxpZXMpXG4gICAgICAgIHNlbGYuX3JlY2VpdmUocmVwbGllcyk7XG4gICAgICBlbHNlXG4gICAgICAgIHNlbGYuX2hhbmRsZUVycm9yKFtdKTtcbiAgICB9O1xuXG4gICAgdGhpcy5fc29ja2V0ID0gc29ja2V0O1xuICB9LFxuXG4gIGNsb3NlOiBmdW5jdGlvbigpIHtcbiAgICBpZiAoIXRoaXMuX3NvY2tldCkgcmV0dXJuO1xuICAgIHRoaXMuX3NvY2tldC5vbm9wZW4gPSB0aGlzLl9zb2NrZXQub25lcnJvciA9IHRoaXMuX3NvY2tldC5vbm1lc3NhZ2UgPSBudWxsO1xuICAgIHRoaXMuX3NvY2tldC5jbG9zZSgpO1xuICAgIGRlbGV0ZSB0aGlzLl9zb2NrZXQ7XG4gIH0sXG5cbiAgaXNVc2FibGU6IGZ1bmN0aW9uKGNhbGxiYWNrLCBjb250ZXh0KSB7XG4gICAgdGhpcy5jYWxsYmFjayhmdW5jdGlvbigpIHsgY2FsbGJhY2suY2FsbChjb250ZXh0LCB0cnVlKSB9KTtcbiAgICB0aGlzLmVycmJhY2soZnVuY3Rpb24oKSB7IGNhbGxiYWNrLmNhbGwoY29udGV4dCwgZmFsc2UpIH0pO1xuICB9LFxuXG4gIGVuY29kZTogZnVuY3Rpb24obWVzc2FnZXMpIHtcbiAgICByZXR1cm4gdGhpcy5feGhyLmVuY29kZShtZXNzYWdlcyk7XG4gIH0sXG5cbiAgcmVxdWVzdDogZnVuY3Rpb24obWVzc2FnZXMpIHtcbiAgICByZXR1cm4gdGhpcy5feGhyLnJlcXVlc3QobWVzc2FnZXMpO1xuICB9XG5cbn0pLCB7XG4gIGlzVXNhYmxlOiBmdW5jdGlvbihkaXNwYXRjaGVyLCBlbmRwb2ludCwgY2FsbGJhY2ssIGNvbnRleHQpIHtcbiAgICB2YXIgaWQgPSBkaXNwYXRjaGVyLmNsaWVudElkO1xuICAgIGlmICghaWQpIHJldHVybiBjYWxsYmFjay5jYWxsKGNvbnRleHQsIGZhbHNlKTtcblxuICAgIFhIUi5pc1VzYWJsZShkaXNwYXRjaGVyLCBlbmRwb2ludCwgZnVuY3Rpb24odXNhYmxlKSB7XG4gICAgICBpZiAoIXVzYWJsZSkgcmV0dXJuIGNhbGxiYWNrLmNhbGwoY29udGV4dCwgZmFsc2UpO1xuICAgICAgdGhpcy5jcmVhdGUoZGlzcGF0Y2hlciwgZW5kcG9pbnQpLmlzVXNhYmxlKGNhbGxiYWNrLCBjb250ZXh0KTtcbiAgICB9LCB0aGlzKTtcbiAgfSxcblxuICBjcmVhdGU6IGZ1bmN0aW9uKGRpc3BhdGNoZXIsIGVuZHBvaW50KSB7XG4gICAgdmFyIHNvY2tldHMgPSBkaXNwYXRjaGVyLnRyYW5zcG9ydHMuZXZlbnRzb3VyY2UgPSBkaXNwYXRjaGVyLnRyYW5zcG9ydHMuZXZlbnRzb3VyY2UgfHwge30sXG4gICAgICAgIGlkICAgICAgPSBkaXNwYXRjaGVyLmNsaWVudElkO1xuXG4gICAgdmFyIHVybCA9IGNvcHlPYmplY3QoZW5kcG9pbnQpO1xuICAgIHVybC5wYXRobmFtZSArPSAnLycgKyAoaWQgfHwgJycpO1xuICAgIHVybCA9IFVSSS5zdHJpbmdpZnkodXJsKTtcblxuICAgIHNvY2tldHNbdXJsXSA9IHNvY2tldHNbdXJsXSB8fCBuZXcgdGhpcyhkaXNwYXRjaGVyLCBlbmRwb2ludCk7XG4gICAgcmV0dXJuIHNvY2tldHNbdXJsXTtcbiAgfVxufSk7XG5cbmFzc2lnbihFdmVudFNvdXJjZS5wcm90b3R5cGUsIERlZmVycmFibGUpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IEV2ZW50U291cmNlO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgQ2xhc3MgICAgICA9IHJlcXVpcmUoJy4uL3V0aWwvY2xhc3MnKSxcbiAgICBVUkkgICAgICAgID0gcmVxdWlyZSgnLi4vdXRpbC91cmknKSxcbiAgICBjb3B5T2JqZWN0ID0gcmVxdWlyZSgnLi4vdXRpbC9jb3B5X29iamVjdCcpLFxuICAgIGFzc2lnbiAgICAgPSByZXF1aXJlKCcuLi91dGlsL2Fzc2lnbicpLFxuICAgIHRvSlNPTiAgICAgPSByZXF1aXJlKCcuLi91dGlsL3RvX2pzb24nKSxcbiAgICBUcmFuc3BvcnQgID0gcmVxdWlyZSgnLi90cmFuc3BvcnQnKTtcblxudmFyIEpTT05QID0gYXNzaWduKENsYXNzKFRyYW5zcG9ydCwge1xuIGVuY29kZTogZnVuY3Rpb24obWVzc2FnZXMpIHtcbiAgICB2YXIgdXJsID0gY29weU9iamVjdCh0aGlzLmVuZHBvaW50KTtcbiAgICB1cmwucXVlcnkubWVzc2FnZSA9IHRvSlNPTihtZXNzYWdlcyk7XG4gICAgdXJsLnF1ZXJ5Lmpzb25wICAgPSAnX19qc29ucCcgKyBKU09OUC5fY2JDb3VudCArICdfXyc7XG4gICAgcmV0dXJuIFVSSS5zdHJpbmdpZnkodXJsKTtcbiAgfSxcblxuICByZXF1ZXN0OiBmdW5jdGlvbihtZXNzYWdlcykge1xuICAgIHZhciBoZWFkICAgICAgICAgPSBkb2N1bWVudC5nZXRFbGVtZW50c0J5VGFnTmFtZSgnaGVhZCcpWzBdLFxuICAgICAgICBzY3JpcHQgICAgICAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzY3JpcHQnKSxcbiAgICAgICAgY2FsbGJhY2tOYW1lID0gSlNPTlAuZ2V0Q2FsbGJhY2tOYW1lKCksXG4gICAgICAgIGVuZHBvaW50ICAgICA9IGNvcHlPYmplY3QodGhpcy5lbmRwb2ludCksXG4gICAgICAgIHNlbGYgICAgICAgICA9IHRoaXM7XG5cbiAgICBlbmRwb2ludC5xdWVyeS5tZXNzYWdlID0gdG9KU09OKG1lc3NhZ2VzKTtcbiAgICBlbmRwb2ludC5xdWVyeS5qc29ucCAgID0gY2FsbGJhY2tOYW1lO1xuXG4gICAgdmFyIGNsZWFudXAgPSBmdW5jdGlvbigpIHtcbiAgICAgIGlmICghZ2xvYmFsW2NhbGxiYWNrTmFtZV0pIHJldHVybiBmYWxzZTtcbiAgICAgIGdsb2JhbFtjYWxsYmFja05hbWVdID0gdW5kZWZpbmVkO1xuICAgICAgdHJ5IHsgZGVsZXRlIGdsb2JhbFtjYWxsYmFja05hbWVdIH0gY2F0Y2ggKGVycm9yKSB7fVxuICAgICAgc2NyaXB0LnBhcmVudE5vZGUucmVtb3ZlQ2hpbGQoc2NyaXB0KTtcbiAgICB9O1xuXG4gICAgZ2xvYmFsW2NhbGxiYWNrTmFtZV0gPSBmdW5jdGlvbihyZXBsaWVzKSB7XG4gICAgICBjbGVhbnVwKCk7XG4gICAgICBzZWxmLl9yZWNlaXZlKHJlcGxpZXMpO1xuICAgIH07XG5cbiAgICBzY3JpcHQudHlwZSA9ICd0ZXh0L2phdmFzY3JpcHQnO1xuICAgIHNjcmlwdC5zcmMgID0gVVJJLnN0cmluZ2lmeShlbmRwb2ludCk7XG4gICAgaGVhZC5hcHBlbmRDaGlsZChzY3JpcHQpO1xuXG4gICAgc2NyaXB0Lm9uZXJyb3IgPSBmdW5jdGlvbigpIHtcbiAgICAgIGNsZWFudXAoKTtcbiAgICAgIHNlbGYuX2hhbmRsZUVycm9yKG1lc3NhZ2VzKTtcbiAgICB9O1xuXG4gICAgcmV0dXJuIHsgYWJvcnQ6IGNsZWFudXAgfTtcbiAgfVxufSksIHtcbiAgX2NiQ291bnQ6IDAsXG5cbiAgZ2V0Q2FsbGJhY2tOYW1lOiBmdW5jdGlvbigpIHtcbiAgICB0aGlzLl9jYkNvdW50ICs9IDE7XG4gICAgcmV0dXJuICdfX2pzb25wJyArIHRoaXMuX2NiQ291bnQgKyAnX18nO1xuICB9LFxuXG4gIGlzVXNhYmxlOiBmdW5jdGlvbihkaXNwYXRjaGVyLCBlbmRwb2ludCwgY2FsbGJhY2ssIGNvbnRleHQpIHtcbiAgICBjYWxsYmFjay5jYWxsKGNvbnRleHQsIHRydWUpO1xuICB9XG59KTtcblxubW9kdWxlLmV4cG9ydHMgPSBKU09OUDtcbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIENsYXNzICAgID0gcmVxdWlyZSgnLi4vdXRpbC9jbGFzcycpLFxuICAgIENvb2tpZSAgID0gcmVxdWlyZSgnLi4vdXRpbC9jb29raWVzJykuQ29va2llLFxuICAgIFByb21pc2UgID0gcmVxdWlyZSgnLi4vdXRpbC9wcm9taXNlJyksXG4gICAgYXJyYXkgICAgPSByZXF1aXJlKCcuLi91dGlsL2FycmF5JyksXG4gICAgYXNzaWduICAgPSByZXF1aXJlKCcuLi91dGlsL2Fzc2lnbicpLFxuICAgIExvZ2dpbmcgID0gcmVxdWlyZSgnLi4vbWl4aW5zL2xvZ2dpbmcnKSxcbiAgICBUaW1lb3V0cyA9IHJlcXVpcmUoJy4uL21peGlucy90aW1lb3V0cycpLFxuICAgIENoYW5uZWwgID0gcmVxdWlyZSgnLi4vcHJvdG9jb2wvY2hhbm5lbCcpO1xuXG52YXIgVHJhbnNwb3J0ID0gYXNzaWduKENsYXNzKHsgY2xhc3NOYW1lOiAnVHJhbnNwb3J0JyxcbiAgREVGQVVMVF9QT1JUUzogeyAnaHR0cDonOiA4MCwgJ2h0dHBzOic6IDQ0MywgJ3dzOic6IDgwLCAnd3NzOic6IDQ0MyB9LFxuICBNQVhfREVMQVk6ICAgICAwLFxuXG4gIGJhdGNoaW5nOiAgdHJ1ZSxcblxuICBpbml0aWFsaXplOiBmdW5jdGlvbihkaXNwYXRjaGVyLCBlbmRwb2ludCkge1xuICAgIHRoaXMuX2Rpc3BhdGNoZXIgPSBkaXNwYXRjaGVyO1xuICAgIHRoaXMuZW5kcG9pbnQgICAgPSBlbmRwb2ludDtcbiAgICB0aGlzLl9vdXRib3ggICAgID0gW107XG4gICAgdGhpcy5fcHJveHkgICAgICA9IGFzc2lnbih7fSwgdGhpcy5fZGlzcGF0Y2hlci5wcm94eSk7XG5cbiAgICBpZiAoIXRoaXMuX3Byb3h5Lm9yaWdpbilcbiAgICAgIHRoaXMuX3Byb3h5Lm9yaWdpbiA9IHRoaXMuX2ZpbmRQcm94eSgpO1xuICB9LFxuXG4gIGNsb3NlOiBmdW5jdGlvbigpIHt9LFxuXG4gIGVuY29kZTogZnVuY3Rpb24obWVzc2FnZXMpIHtcbiAgICByZXR1cm4gJyc7XG4gIH0sXG5cbiAgc2VuZE1lc3NhZ2U6IGZ1bmN0aW9uKG1lc3NhZ2UpIHtcbiAgICB0aGlzLmRlYnVnKCdDbGllbnQgPyBzZW5kaW5nIG1lc3NhZ2UgdG8gPzogPycsXG4gICAgICAgICAgICAgICB0aGlzLl9kaXNwYXRjaGVyLmNsaWVudElkLCB0aGlzLmVuZHBvaW50LmhyZWYsIG1lc3NhZ2UpO1xuXG4gICAgaWYgKCF0aGlzLmJhdGNoaW5nKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHRoaXMucmVxdWVzdChbbWVzc2FnZV0pKTtcblxuICAgIHRoaXMuX291dGJveC5wdXNoKG1lc3NhZ2UpO1xuICAgIHRoaXMuX2ZsdXNoTGFyZ2VCYXRjaCgpO1xuXG4gICAgaWYgKG1lc3NhZ2UuY2hhbm5lbCA9PT0gQ2hhbm5lbC5IQU5EU0hBS0UpXG4gICAgICByZXR1cm4gdGhpcy5fcHVibGlzaCgwLjAxKTtcblxuICAgIGlmIChtZXNzYWdlLmNoYW5uZWwgPT09IENoYW5uZWwuQ09OTkVDVClcbiAgICAgIHRoaXMuX2Nvbm5lY3RNZXNzYWdlID0gbWVzc2FnZTtcblxuICAgIHJldHVybiB0aGlzLl9wdWJsaXNoKHRoaXMuTUFYX0RFTEFZKTtcbiAgfSxcblxuICBfbWFrZVByb21pc2U6IGZ1bmN0aW9uKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIHRoaXMuX3JlcXVlc3RQcm9taXNlID0gdGhpcy5fcmVxdWVzdFByb21pc2UgfHwgbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSkge1xuICAgICAgc2VsZi5fcmVzb2x2ZVByb21pc2UgPSByZXNvbHZlO1xuICAgIH0pO1xuICB9LFxuXG4gIF9wdWJsaXNoOiBmdW5jdGlvbihkZWxheSkge1xuICAgIHRoaXMuX21ha2VQcm9taXNlKCk7XG5cbiAgICB0aGlzLmFkZFRpbWVvdXQoJ3B1Ymxpc2gnLCBkZWxheSwgZnVuY3Rpb24oKSB7XG4gICAgICB0aGlzLl9mbHVzaCgpO1xuICAgICAgZGVsZXRlIHRoaXMuX3JlcXVlc3RQcm9taXNlO1xuICAgIH0sIHRoaXMpO1xuXG4gICAgcmV0dXJuIHRoaXMuX3JlcXVlc3RQcm9taXNlO1xuICB9LFxuXG4gIF9mbHVzaDogZnVuY3Rpb24oKSB7XG4gICAgdGhpcy5yZW1vdmVUaW1lb3V0KCdwdWJsaXNoJyk7XG5cbiAgICBpZiAodGhpcy5fb3V0Ym94Lmxlbmd0aCA+IDEgJiYgdGhpcy5fY29ubmVjdE1lc3NhZ2UpXG4gICAgICB0aGlzLl9jb25uZWN0TWVzc2FnZS5hZHZpY2UgPSB7IHRpbWVvdXQ6IDAgfTtcblxuICAgIHRoaXMuX3Jlc29sdmVQcm9taXNlKHRoaXMucmVxdWVzdCh0aGlzLl9vdXRib3gpKTtcblxuICAgIHRoaXMuX2Nvbm5lY3RNZXNzYWdlID0gbnVsbDtcbiAgICB0aGlzLl9vdXRib3ggPSBbXTtcbiAgfSxcblxuICBfZmx1c2hMYXJnZUJhdGNoOiBmdW5jdGlvbigpIHtcbiAgICB2YXIgc3RyaW5nID0gdGhpcy5lbmNvZGUodGhpcy5fb3V0Ym94KTtcbiAgICBpZiAoc3RyaW5nLmxlbmd0aCA8IHRoaXMuX2Rpc3BhdGNoZXIubWF4UmVxdWVzdFNpemUpIHJldHVybjtcbiAgICB2YXIgbGFzdCA9IHRoaXMuX291dGJveC5wb3AoKTtcblxuICAgIHRoaXMuX21ha2VQcm9taXNlKCk7XG4gICAgdGhpcy5fZmx1c2goKTtcblxuICAgIGlmIChsYXN0KSB0aGlzLl9vdXRib3gucHVzaChsYXN0KTtcbiAgfSxcblxuICBfcmVjZWl2ZTogZnVuY3Rpb24ocmVwbGllcykge1xuICAgIGlmICghcmVwbGllcykgcmV0dXJuO1xuICAgIHJlcGxpZXMgPSBbXS5jb25jYXQocmVwbGllcyk7XG5cbiAgICB0aGlzLmRlYnVnKCdDbGllbnQgPyByZWNlaXZlZCBmcm9tID8gdmlhID86ID8nLFxuICAgICAgICAgICAgICAgdGhpcy5fZGlzcGF0Y2hlci5jbGllbnRJZCwgdGhpcy5lbmRwb2ludC5ocmVmLCB0aGlzLmNvbm5lY3Rpb25UeXBlLCByZXBsaWVzKTtcblxuICAgIGZvciAodmFyIGkgPSAwLCBuID0gcmVwbGllcy5sZW5ndGg7IGkgPCBuOyBpKyspXG4gICAgICB0aGlzLl9kaXNwYXRjaGVyLmhhbmRsZVJlc3BvbnNlKHJlcGxpZXNbaV0pO1xuICB9LFxuXG4gIF9oYW5kbGVFcnJvcjogZnVuY3Rpb24obWVzc2FnZXMsIGltbWVkaWF0ZSkge1xuICAgIG1lc3NhZ2VzID0gW10uY29uY2F0KG1lc3NhZ2VzKTtcblxuICAgIHRoaXMuZGVidWcoJ0NsaWVudCA/IGZhaWxlZCB0byBzZW5kIHRvID8gdmlhID86ID8nLFxuICAgICAgICAgICAgICAgdGhpcy5fZGlzcGF0Y2hlci5jbGllbnRJZCwgdGhpcy5lbmRwb2ludC5ocmVmLCB0aGlzLmNvbm5lY3Rpb25UeXBlLCBtZXNzYWdlcyk7XG5cbiAgICBmb3IgKHZhciBpID0gMCwgbiA9IG1lc3NhZ2VzLmxlbmd0aDsgaSA8IG47IGkrKylcbiAgICAgIHRoaXMuX2Rpc3BhdGNoZXIuaGFuZGxlRXJyb3IobWVzc2FnZXNbaV0pO1xuICB9LFxuXG4gIF9nZXRDb29raWVzOiBmdW5jdGlvbigpIHtcbiAgICB2YXIgY29va2llcyA9IHRoaXMuX2Rpc3BhdGNoZXIuY29va2llcyxcbiAgICAgICAgdXJsICAgICA9IHRoaXMuZW5kcG9pbnQuaHJlZjtcblxuICAgIGlmICghY29va2llcykgcmV0dXJuICcnO1xuXG4gICAgcmV0dXJuIGFycmF5Lm1hcChjb29raWVzLmdldENvb2tpZXNTeW5jKHVybCksIGZ1bmN0aW9uKGNvb2tpZSkge1xuICAgICAgcmV0dXJuIGNvb2tpZS5jb29raWVTdHJpbmcoKTtcbiAgICB9KS5qb2luKCc7ICcpO1xuICB9LFxuXG4gIF9zdG9yZUNvb2tpZXM6IGZ1bmN0aW9uKHNldENvb2tpZSkge1xuICAgIHZhciBjb29raWVzID0gdGhpcy5fZGlzcGF0Y2hlci5jb29raWVzLFxuICAgICAgICB1cmwgICAgID0gdGhpcy5lbmRwb2ludC5ocmVmLFxuICAgICAgICBjb29raWU7XG5cbiAgICBpZiAoIXNldENvb2tpZSB8fCAhY29va2llcykgcmV0dXJuO1xuICAgIHNldENvb2tpZSA9IFtdLmNvbmNhdChzZXRDb29raWUpO1xuXG4gICAgZm9yICh2YXIgaSA9IDAsIG4gPSBzZXRDb29raWUubGVuZ3RoOyBpIDwgbjsgaSsrKSB7XG4gICAgICBjb29raWUgPSBDb29raWUucGFyc2Uoc2V0Q29va2llW2ldKTtcbiAgICAgIGNvb2tpZXMuc2V0Q29va2llU3luYyhjb29raWUsIHVybCk7XG4gICAgfVxuICB9LFxuXG4gIF9maW5kUHJveHk6IGZ1bmN0aW9uKCkge1xuICAgIGlmICh0eXBlb2YgcHJvY2VzcyA9PT0gJ3VuZGVmaW5lZCcpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICB2YXIgcHJvdG9jb2wgPSB0aGlzLmVuZHBvaW50LnByb3RvY29sO1xuICAgIGlmICghcHJvdG9jb2wpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICB2YXIgbmFtZSAgID0gcHJvdG9jb2wucmVwbGFjZSgvOiQvLCAnJykudG9Mb3dlckNhc2UoKSArICdfcHJveHknLFxuICAgICAgICB1cGNhc2UgPSBuYW1lLnRvVXBwZXJDYXNlKCksXG4gICAgICAgIGVudiAgICA9IHByb2Nlc3MuZW52LFxuICAgICAgICBrZXlzLCBwcm94eTtcblxuICAgIGlmIChuYW1lID09PSAnaHR0cF9wcm94eScgJiYgZW52LlJFUVVFU1RfTUVUSE9EKSB7XG4gICAgICBrZXlzID0gT2JqZWN0LmtleXMoZW52KS5maWx0ZXIoZnVuY3Rpb24oaykgeyByZXR1cm4gL15odHRwX3Byb3h5JC9pLnRlc3QoaykgfSk7XG4gICAgICBpZiAoa2V5cy5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgaWYgKGtleXNbMF0gPT09IG5hbWUgJiYgZW52W3VwY2FzZV0gPT09IHVuZGVmaW5lZClcbiAgICAgICAgICBwcm94eSA9IGVudltuYW1lXTtcbiAgICAgIH0gZWxzZSBpZiAoa2V5cy5sZW5ndGggPiAxKSB7XG4gICAgICAgIHByb3h5ID0gZW52W25hbWVdO1xuICAgICAgfVxuICAgICAgcHJveHkgPSBwcm94eSB8fCBlbnZbJ0NHSV8nICsgdXBjYXNlXTtcbiAgICB9IGVsc2Uge1xuICAgICAgcHJveHkgPSBlbnZbbmFtZV0gfHwgZW52W3VwY2FzZV07XG4gICAgICBpZiAocHJveHkgJiYgIWVudltuYW1lXSlcbiAgICAgICAgY29uc29sZS53YXJuKCdUaGUgZW52aXJvbm1lbnQgdmFyaWFibGUgJyArIHVwY2FzZSArXG4gICAgICAgICAgICAgICAgICAgICAnIGlzIGRpc2NvdXJhZ2VkLiBVc2UgJyArIG5hbWUgKyAnLicpO1xuICAgIH1cbiAgICByZXR1cm4gcHJveHk7XG4gIH1cblxufSksIHtcbiAgZ2V0OiBmdW5jdGlvbihkaXNwYXRjaGVyLCBhbGxvd2VkLCBkaXNhYmxlZCwgY2FsbGJhY2ssIGNvbnRleHQpIHtcbiAgICB2YXIgZW5kcG9pbnQgPSBkaXNwYXRjaGVyLmVuZHBvaW50O1xuXG4gICAgYXJyYXkuYXN5bmNFYWNoKHRoaXMuX3RyYW5zcG9ydHMsIGZ1bmN0aW9uKHBhaXIsIHJlc3VtZSkge1xuICAgICAgdmFyIGNvbm5UeXBlICAgICA9IHBhaXJbMF0sIGtsYXNzID0gcGFpclsxXSxcbiAgICAgICAgICBjb25uRW5kcG9pbnQgPSBkaXNwYXRjaGVyLmVuZHBvaW50Rm9yKGNvbm5UeXBlKTtcblxuICAgICAgaWYgKGFycmF5LmluZGV4T2YoZGlzYWJsZWQsIGNvbm5UeXBlKSA+PSAwKVxuICAgICAgICByZXR1cm4gcmVzdW1lKCk7XG5cbiAgICAgIGlmIChhcnJheS5pbmRleE9mKGFsbG93ZWQsIGNvbm5UeXBlKSA8IDApIHtcbiAgICAgICAga2xhc3MuaXNVc2FibGUoZGlzcGF0Y2hlciwgY29ubkVuZHBvaW50LCBmdW5jdGlvbigpIHt9KTtcbiAgICAgICAgcmV0dXJuIHJlc3VtZSgpO1xuICAgICAgfVxuXG4gICAgICBrbGFzcy5pc1VzYWJsZShkaXNwYXRjaGVyLCBjb25uRW5kcG9pbnQsIGZ1bmN0aW9uKGlzVXNhYmxlKSB7XG4gICAgICAgIGlmICghaXNVc2FibGUpIHJldHVybiByZXN1bWUoKTtcbiAgICAgICAgdmFyIHRyYW5zcG9ydCA9IGtsYXNzLmhhc093blByb3BlcnR5KCdjcmVhdGUnKSA/IGtsYXNzLmNyZWF0ZShkaXNwYXRjaGVyLCBjb25uRW5kcG9pbnQpIDogbmV3IGtsYXNzKGRpc3BhdGNoZXIsIGNvbm5FbmRwb2ludCk7XG4gICAgICAgIGNhbGxiYWNrLmNhbGwoY29udGV4dCwgdHJhbnNwb3J0KTtcbiAgICAgIH0pO1xuICAgIH0sIGZ1bmN0aW9uKCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdDb3VsZCBub3QgZmluZCBhIHVzYWJsZSBjb25uZWN0aW9uIHR5cGUgZm9yICcgKyBlbmRwb2ludC5ocmVmKTtcbiAgICB9KTtcbiAgfSxcblxuICByZWdpc3RlcjogZnVuY3Rpb24odHlwZSwga2xhc3MpIHtcbiAgICB0aGlzLl90cmFuc3BvcnRzLnB1c2goW3R5cGUsIGtsYXNzXSk7XG4gICAga2xhc3MucHJvdG90eXBlLmNvbm5lY3Rpb25UeXBlID0gdHlwZTtcbiAgfSxcblxuICBnZXRDb25uZWN0aW9uVHlwZXM6IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBhcnJheS5tYXAodGhpcy5fdHJhbnNwb3J0cywgZnVuY3Rpb24odCkgeyByZXR1cm4gdFswXSB9KTtcbiAgfSxcblxuICBkaXNhYmxlOiBmdW5jdGlvbihmZWF0dXJlKSB7XG4gICAgaWYgKGZlYXR1cmUgIT09ICdhdXRvZGlzY29ubmVjdCcpIHJldHVybjtcblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdGhpcy5fdHJhbnNwb3J0cy5sZW5ndGg7IGkrKylcbiAgICAgIHRoaXMuX3RyYW5zcG9ydHNbaV1bMV0uX3VubG9hZGVkID0gZmFsc2U7XG4gIH0sXG5cbiAgX3RyYW5zcG9ydHM6IFtdXG59KTtcblxuYXNzaWduKFRyYW5zcG9ydC5wcm90b3R5cGUsIExvZ2dpbmcpO1xuYXNzaWduKFRyYW5zcG9ydC5wcm90b3R5cGUsIFRpbWVvdXRzKTtcblxubW9kdWxlLmV4cG9ydHMgPSBUcmFuc3BvcnQ7XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBDbGFzcyAgICAgID0gcmVxdWlyZSgnLi4vdXRpbC9jbGFzcycpLFxuICAgIFByb21pc2UgICAgPSByZXF1aXJlKCcuLi91dGlsL3Byb21pc2UnKSxcbiAgICBTZXQgICAgICAgID0gcmVxdWlyZSgnLi4vdXRpbC9zZXQnKSxcbiAgICBVUkkgICAgICAgID0gcmVxdWlyZSgnLi4vdXRpbC91cmknKSxcbiAgICBicm93c2VyICAgID0gcmVxdWlyZSgnLi4vdXRpbC9icm93c2VyJyksXG4gICAgY29weU9iamVjdCA9IHJlcXVpcmUoJy4uL3V0aWwvY29weV9vYmplY3QnKSxcbiAgICBhc3NpZ24gICAgID0gcmVxdWlyZSgnLi4vdXRpbC9hc3NpZ24nKSxcbiAgICB0b0pTT04gICAgID0gcmVxdWlyZSgnLi4vdXRpbC90b19qc29uJyksXG4gICAgd3MgICAgICAgICA9IHJlcXVpcmUoJy4uL3V0aWwvd2Vic29ja2V0JyksXG4gICAgRGVmZXJyYWJsZSA9IHJlcXVpcmUoJy4uL21peGlucy9kZWZlcnJhYmxlJyksXG4gICAgVHJhbnNwb3J0ICA9IHJlcXVpcmUoJy4vdHJhbnNwb3J0Jyk7XG5cbnZhciBXZWJTb2NrZXQgPSBhc3NpZ24oQ2xhc3MoVHJhbnNwb3J0LCB7XG4gIFVOQ09OTkVDVEVEOiAgMSxcbiAgQ09OTkVDVElORzogICAyLFxuICBDT05ORUNURUQ6ICAgIDMsXG5cbiAgYmF0Y2hpbmc6ICAgICBmYWxzZSxcblxuICBpc1VzYWJsZTogZnVuY3Rpb24oY2FsbGJhY2ssIGNvbnRleHQpIHtcbiAgICB0aGlzLmNhbGxiYWNrKGZ1bmN0aW9uKCkgeyBjYWxsYmFjay5jYWxsKGNvbnRleHQsIHRydWUpIH0pO1xuICAgIHRoaXMuZXJyYmFjayhmdW5jdGlvbigpIHsgY2FsbGJhY2suY2FsbChjb250ZXh0LCBmYWxzZSkgfSk7XG4gICAgdGhpcy5jb25uZWN0KCk7XG4gIH0sXG5cbiAgcmVxdWVzdDogZnVuY3Rpb24obWVzc2FnZXMpIHtcbiAgICB0aGlzLl9wZW5kaW5nID0gdGhpcy5fcGVuZGluZyB8fCBuZXcgU2V0KCk7XG4gICAgZm9yICh2YXIgaSA9IDAsIG4gPSBtZXNzYWdlcy5sZW5ndGg7IGkgPCBuOyBpKyspIHRoaXMuX3BlbmRpbmcuYWRkKG1lc3NhZ2VzW2ldKTtcblxuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIHZhciBwcm9taXNlID0gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgICBzZWxmLmNhbGxiYWNrKGZ1bmN0aW9uKHNvY2tldCkge1xuICAgICAgICBpZiAoIXNvY2tldCB8fCBzb2NrZXQucmVhZHlTdGF0ZSAhPT0gMSkgcmV0dXJuO1xuICAgICAgICBzb2NrZXQuc2VuZCh0b0pTT04obWVzc2FnZXMpKTtcbiAgICAgICAgcmVzb2x2ZShzb2NrZXQpO1xuICAgICAgfSk7XG5cbiAgICAgIHNlbGYuY29ubmVjdCgpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIGFib3J0OiBmdW5jdGlvbigpIHsgcHJvbWlzZS50aGVuKGZ1bmN0aW9uKHdzKSB7IHdzLmNsb3NlKCkgfSkgfVxuICAgIH07XG4gIH0sXG5cbiAgY29ubmVjdDogZnVuY3Rpb24oKSB7XG4gICAgaWYgKFdlYlNvY2tldC5fdW5sb2FkZWQpIHJldHVybjtcblxuICAgIHRoaXMuX3N0YXRlID0gdGhpcy5fc3RhdGUgfHwgdGhpcy5VTkNPTk5FQ1RFRDtcbiAgICBpZiAodGhpcy5fc3RhdGUgIT09IHRoaXMuVU5DT05ORUNURUQpIHJldHVybjtcbiAgICB0aGlzLl9zdGF0ZSA9IHRoaXMuQ09OTkVDVElORztcblxuICAgIHZhciBzb2NrZXQgPSB0aGlzLl9jcmVhdGVTb2NrZXQoKTtcbiAgICBpZiAoIXNvY2tldCkgcmV0dXJuIHRoaXMuc2V0RGVmZXJyZWRTdGF0dXMoJ2ZhaWxlZCcpO1xuXG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gICAgc29ja2V0Lm9ub3BlbiA9IGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKHNvY2tldC5oZWFkZXJzKSBzZWxmLl9zdG9yZUNvb2tpZXMoc29ja2V0LmhlYWRlcnNbJ3NldC1jb29raWUnXSk7XG4gICAgICBzZWxmLl9zb2NrZXQgPSBzb2NrZXQ7XG4gICAgICBzZWxmLl9zdGF0ZSA9IHNlbGYuQ09OTkVDVEVEO1xuICAgICAgc2VsZi5fZXZlckNvbm5lY3RlZCA9IHRydWU7XG4gICAgICBzZWxmLnNldERlZmVycmVkU3RhdHVzKCdzdWNjZWVkZWQnLCBzb2NrZXQpO1xuICAgIH07XG5cbiAgICB2YXIgY2xvc2VkID0gZmFsc2U7XG4gICAgc29ja2V0Lm9uY2xvc2UgPSBzb2NrZXQub25lcnJvciA9IGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgICAgY2xvc2VkID0gdHJ1ZTtcblxuICAgICAgdmFyIHdhc0Nvbm5lY3RlZCA9IChzZWxmLl9zdGF0ZSA9PT0gc2VsZi5DT05ORUNURUQpO1xuICAgICAgc29ja2V0Lm9ub3BlbiA9IHNvY2tldC5vbmNsb3NlID0gc29ja2V0Lm9uZXJyb3IgPSBzb2NrZXQub25tZXNzYWdlID0gbnVsbDtcblxuICAgICAgZGVsZXRlIHNlbGYuX3NvY2tldDtcbiAgICAgIHNlbGYuX3N0YXRlID0gc2VsZi5VTkNPTk5FQ1RFRDtcblxuICAgICAgdmFyIHBlbmRpbmcgPSBzZWxmLl9wZW5kaW5nID8gc2VsZi5fcGVuZGluZy50b0FycmF5KCkgOiBbXTtcbiAgICAgIGRlbGV0ZSBzZWxmLl9wZW5kaW5nO1xuXG4gICAgICBpZiAod2FzQ29ubmVjdGVkIHx8IHNlbGYuX2V2ZXJDb25uZWN0ZWQpIHtcbiAgICAgICAgc2VsZi5zZXREZWZlcnJlZFN0YXR1cygndW5rbm93bicpO1xuICAgICAgICBzZWxmLl9oYW5kbGVFcnJvcihwZW5kaW5nLCB3YXNDb25uZWN0ZWQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc2VsZi5zZXREZWZlcnJlZFN0YXR1cygnZmFpbGVkJyk7XG4gICAgICB9XG4gICAgfTtcblxuICAgIHNvY2tldC5vbm1lc3NhZ2UgPSBmdW5jdGlvbihldmVudCkge1xuICAgICAgdmFyIHJlcGxpZXM7XG4gICAgICB0cnkgeyByZXBsaWVzID0gSlNPTi5wYXJzZShldmVudC5kYXRhKSB9IGNhdGNoIChlcnJvcikge31cblxuICAgICAgaWYgKCFyZXBsaWVzKSByZXR1cm47XG5cbiAgICAgIHJlcGxpZXMgPSBbXS5jb25jYXQocmVwbGllcyk7XG5cbiAgICAgIGZvciAodmFyIGkgPSAwLCBuID0gcmVwbGllcy5sZW5ndGg7IGkgPCBuOyBpKyspIHtcbiAgICAgICAgaWYgKHJlcGxpZXNbaV0uc3VjY2Vzc2Z1bCA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICAgICAgc2VsZi5fcGVuZGluZy5yZW1vdmUocmVwbGllc1tpXSk7XG4gICAgICB9XG4gICAgICBzZWxmLl9yZWNlaXZlKHJlcGxpZXMpO1xuICAgIH07XG4gIH0sXG5cbiAgY2xvc2U6IGZ1bmN0aW9uKCkge1xuICAgIGlmICghdGhpcy5fc29ja2V0KSByZXR1cm47XG4gICAgdGhpcy5fc29ja2V0LmNsb3NlKCk7XG4gIH0sXG5cbiAgX2NyZWF0ZVNvY2tldDogZnVuY3Rpb24oKSB7XG4gICAgdmFyIHVybCAgICAgICAgPSBXZWJTb2NrZXQuZ2V0U29ja2V0VXJsKHRoaXMuZW5kcG9pbnQpLFxuICAgICAgICBoZWFkZXJzICAgID0gdGhpcy5fZGlzcGF0Y2hlci5oZWFkZXJzLFxuICAgICAgICBleHRlbnNpb25zID0gdGhpcy5fZGlzcGF0Y2hlci53c0V4dGVuc2lvbnMsXG4gICAgICAgIGNvb2tpZSAgICAgPSB0aGlzLl9nZXRDb29raWVzKCksXG4gICAgICAgIHRscyAgICAgICAgPSB0aGlzLl9kaXNwYXRjaGVyLnRscyxcbiAgICAgICAgb3B0aW9ucyAgICA9IHsgZXh0ZW5zaW9uczogZXh0ZW5zaW9ucywgaGVhZGVyczogaGVhZGVycywgcHJveHk6IHRoaXMuX3Byb3h5LCB0bHM6IHRscyB9O1xuXG4gICAgaWYgKGNvb2tpZSAhPT0gJycpIG9wdGlvbnMuaGVhZGVyc1snQ29va2llJ10gPSBjb29raWU7XG5cbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHdzLmNyZWF0ZSh1cmwsIFtdLCBvcHRpb25zKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAvLyBjYXRjaCBDU1AgZXJyb3IgdG8gYWxsb3cgdHJhbnNwb3J0IHRvIGZhbGxiYWNrIHRvIG5leHQgY29ublR5cGVcbiAgICB9XG4gIH1cblxufSksIHtcbiAgUFJPVE9DT0xTOiB7XG4gICAgJ2h0dHA6JzogICd3czonLFxuICAgICdodHRwczonOiAnd3NzOidcbiAgfSxcblxuICBjcmVhdGU6IGZ1bmN0aW9uKGRpc3BhdGNoZXIsIGVuZHBvaW50KSB7XG4gICAgdmFyIHNvY2tldHMgPSBkaXNwYXRjaGVyLnRyYW5zcG9ydHMud2Vic29ja2V0ID0gZGlzcGF0Y2hlci50cmFuc3BvcnRzLndlYnNvY2tldCB8fCB7fTtcbiAgICBzb2NrZXRzW2VuZHBvaW50LmhyZWZdID0gc29ja2V0c1tlbmRwb2ludC5ocmVmXSB8fCBuZXcgdGhpcyhkaXNwYXRjaGVyLCBlbmRwb2ludCk7XG4gICAgcmV0dXJuIHNvY2tldHNbZW5kcG9pbnQuaHJlZl07XG4gIH0sXG5cbiAgZ2V0U29ja2V0VXJsOiBmdW5jdGlvbihlbmRwb2ludCkge1xuICAgIGVuZHBvaW50ID0gY29weU9iamVjdChlbmRwb2ludCk7XG4gICAgZW5kcG9pbnQucHJvdG9jb2wgPSB0aGlzLlBST1RPQ09MU1tlbmRwb2ludC5wcm90b2NvbF07XG4gICAgcmV0dXJuIFVSSS5zdHJpbmdpZnkoZW5kcG9pbnQpO1xuICB9LFxuXG4gIGlzVXNhYmxlOiBmdW5jdGlvbihkaXNwYXRjaGVyLCBlbmRwb2ludCwgY2FsbGJhY2ssIGNvbnRleHQpIHtcbiAgICB0aGlzLmNyZWF0ZShkaXNwYXRjaGVyLCBlbmRwb2ludCkuaXNVc2FibGUoY2FsbGJhY2ssIGNvbnRleHQpO1xuICB9XG59KTtcblxuYXNzaWduKFdlYlNvY2tldC5wcm90b3R5cGUsIERlZmVycmFibGUpO1xuXG5pZiAoYnJvd3Nlci5FdmVudCAmJiBnbG9iYWwub25iZWZvcmV1bmxvYWQgIT09IHVuZGVmaW5lZCkge1xuICBicm93c2VyLkV2ZW50Lm9uKGdsb2JhbCwgJ2JlZm9yZXVubG9hZCcsIGZ1bmN0aW9uKCkge1xuICAgIGlmIChXZWJTb2NrZXQuX3VubG9hZGVkID09PSB1bmRlZmluZWQpXG4gICAgICBXZWJTb2NrZXQuX3VubG9hZGVkID0gdHJ1ZTtcbiAgfSk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gV2ViU29ja2V0O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgQ2xhc3MgICAgID0gcmVxdWlyZSgnLi4vdXRpbC9jbGFzcycpLFxuICAgIFVSSSAgICAgICA9IHJlcXVpcmUoJy4uL3V0aWwvdXJpJyksXG4gICAgYnJvd3NlciAgID0gcmVxdWlyZSgnLi4vdXRpbC9icm93c2VyJyksXG4gICAgYXNzaWduICAgID0gcmVxdWlyZSgnLi4vdXRpbC9hc3NpZ24nKSxcbiAgICB0b0pTT04gICAgPSByZXF1aXJlKCcuLi91dGlsL3RvX2pzb24nKSxcbiAgICBUcmFuc3BvcnQgPSByZXF1aXJlKCcuL3RyYW5zcG9ydCcpO1xuXG52YXIgWEhSID0gYXNzaWduKENsYXNzKFRyYW5zcG9ydCwge1xuICBlbmNvZGU6IGZ1bmN0aW9uKG1lc3NhZ2VzKSB7XG4gICAgcmV0dXJuIHRvSlNPTihtZXNzYWdlcyk7XG4gIH0sXG5cbiAgcmVxdWVzdDogZnVuY3Rpb24obWVzc2FnZXMpIHtcbiAgICB2YXIgaHJlZiA9IHRoaXMuZW5kcG9pbnQuaHJlZixcbiAgICAgICAgc2VsZiA9IHRoaXMsXG4gICAgICAgIHhocjtcblxuICAgIC8vIFByZWZlciBYTUxIdHRwUmVxdWVzdCBvdmVyIEFjdGl2ZVhPYmplY3QgaWYgdGhleSBib3RoIGV4aXN0XG4gICAgaWYgKGdsb2JhbC5YTUxIdHRwUmVxdWVzdCkge1xuICAgICAgeGhyID0gbmV3IFhNTEh0dHBSZXF1ZXN0KCk7XG4gICAgfSBlbHNlIGlmIChnbG9iYWwuQWN0aXZlWE9iamVjdCkge1xuICAgICAgeGhyID0gbmV3IEFjdGl2ZVhPYmplY3QoJ01pY3Jvc29mdC5YTUxIVFRQJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiB0aGlzLl9oYW5kbGVFcnJvcihtZXNzYWdlcyk7XG4gICAgfVxuXG4gICAgeGhyLm9wZW4oJ1BPU1QnLCBocmVmLCB0cnVlKTtcbiAgICB4aHIuc2V0UmVxdWVzdEhlYWRlcignQ29udGVudC1UeXBlJywgJ2FwcGxpY2F0aW9uL2pzb24nKTtcbiAgICB4aHIuc2V0UmVxdWVzdEhlYWRlcignUHJhZ21hJywgJ25vLWNhY2hlJyk7XG4gICAgeGhyLnNldFJlcXVlc3RIZWFkZXIoJ1gtUmVxdWVzdGVkLVdpdGgnLCAnWE1MSHR0cFJlcXVlc3QnKTtcblxuICAgIHZhciBoZWFkZXJzID0gdGhpcy5fZGlzcGF0Y2hlci5oZWFkZXJzO1xuICAgIGZvciAodmFyIGtleSBpbiBoZWFkZXJzKSB7XG4gICAgICBpZiAoIWhlYWRlcnMuaGFzT3duUHJvcGVydHkoa2V5KSkgY29udGludWU7XG4gICAgICB4aHIuc2V0UmVxdWVzdEhlYWRlcihrZXksIGhlYWRlcnNba2V5XSk7XG4gICAgfVxuXG4gICAgdmFyIGFib3J0ID0gZnVuY3Rpb24oKSB7IHhoci5hYm9ydCgpIH07XG4gICAgaWYgKGdsb2JhbC5vbmJlZm9yZXVubG9hZCAhPT0gdW5kZWZpbmVkKVxuICAgICAgYnJvd3Nlci5FdmVudC5vbihnbG9iYWwsICdiZWZvcmV1bmxvYWQnLCBhYm9ydCk7XG5cbiAgICB4aHIub25yZWFkeXN0YXRlY2hhbmdlID0gZnVuY3Rpb24oKSB7XG4gICAgICBpZiAoIXhociB8fCB4aHIucmVhZHlTdGF0ZSAhPT0gNCkgcmV0dXJuO1xuXG4gICAgICB2YXIgcmVwbGllcyAgICA9IG51bGwsXG4gICAgICAgICAgc3RhdHVzICAgICA9IHhoci5zdGF0dXMsXG4gICAgICAgICAgdGV4dCAgICAgICA9IHhoci5yZXNwb25zZVRleHQsXG4gICAgICAgICAgc3VjY2Vzc2Z1bCA9IChzdGF0dXMgPj0gMjAwICYmIHN0YXR1cyA8IDMwMCkgfHwgc3RhdHVzID09PSAzMDQgfHwgc3RhdHVzID09PSAxMjIzO1xuXG4gICAgICBpZiAoZ2xvYmFsLm9uYmVmb3JldW5sb2FkICE9PSB1bmRlZmluZWQpXG4gICAgICAgIGJyb3dzZXIuRXZlbnQuZGV0YWNoKGdsb2JhbCwgJ2JlZm9yZXVubG9hZCcsIGFib3J0KTtcblxuICAgICAgeGhyLm9ucmVhZHlzdGF0ZWNoYW5nZSA9IGZ1bmN0aW9uKCkge307XG4gICAgICB4aHIgPSBudWxsO1xuXG4gICAgICBpZiAoIXN1Y2Nlc3NmdWwpIHJldHVybiBzZWxmLl9oYW5kbGVFcnJvcihtZXNzYWdlcyk7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIHJlcGxpZXMgPSBKU09OLnBhcnNlKHRleHQpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHt9XG5cbiAgICAgIGlmIChyZXBsaWVzKVxuICAgICAgICBzZWxmLl9yZWNlaXZlKHJlcGxpZXMpO1xuICAgICAgZWxzZVxuICAgICAgICBzZWxmLl9oYW5kbGVFcnJvcihtZXNzYWdlcyk7XG4gICAgfTtcblxuICAgIHhoci5zZW5kKHRoaXMuZW5jb2RlKG1lc3NhZ2VzKSk7XG4gICAgcmV0dXJuIHhocjtcbiAgfVxufSksIHtcbiAgaXNVc2FibGU6IGZ1bmN0aW9uKGRpc3BhdGNoZXIsIGVuZHBvaW50LCBjYWxsYmFjaywgY29udGV4dCkge1xuICAgIHZhciB1c2FibGUgPSAobmF2aWdhdG9yLnByb2R1Y3QgPT09ICdSZWFjdE5hdGl2ZScpXG4gICAgICAgICAgICAgIHx8IFVSSS5pc1NhbWVPcmlnaW4oZW5kcG9pbnQpO1xuXG4gICAgY2FsbGJhY2suY2FsbChjb250ZXh0LCB1c2FibGUpO1xuICB9XG59KTtcblxubW9kdWxlLmV4cG9ydHMgPSBYSFI7XG4iLCIndXNlIHN0cmljdCc7XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICBjb21tb25FbGVtZW50OiBmdW5jdGlvbihsaXN0YSwgbGlzdGIpIHtcbiAgICBmb3IgKHZhciBpID0gMCwgbiA9IGxpc3RhLmxlbmd0aDsgaSA8IG47IGkrKykge1xuICAgICAgaWYgKHRoaXMuaW5kZXhPZihsaXN0YiwgbGlzdGFbaV0pICE9PSAtMSlcbiAgICAgICAgcmV0dXJuIGxpc3RhW2ldO1xuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfSxcblxuICBpbmRleE9mOiBmdW5jdGlvbihsaXN0LCBuZWVkbGUpIHtcbiAgICBpZiAobGlzdC5pbmRleE9mKSByZXR1cm4gbGlzdC5pbmRleE9mKG5lZWRsZSk7XG5cbiAgICBmb3IgKHZhciBpID0gMCwgbiA9IGxpc3QubGVuZ3RoOyBpIDwgbjsgaSsrKSB7XG4gICAgICBpZiAobGlzdFtpXSA9PT0gbmVlZGxlKSByZXR1cm4gaTtcbiAgICB9XG4gICAgcmV0dXJuIC0xO1xuICB9LFxuXG4gIG1hcDogZnVuY3Rpb24ob2JqZWN0LCBjYWxsYmFjaywgY29udGV4dCkge1xuICAgIGlmIChvYmplY3QubWFwKSByZXR1cm4gb2JqZWN0Lm1hcChjYWxsYmFjaywgY29udGV4dCk7XG4gICAgdmFyIHJlc3VsdCA9IFtdO1xuXG4gICAgaWYgKG9iamVjdCBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgICBmb3IgKHZhciBpID0gMCwgbiA9IG9iamVjdC5sZW5ndGg7IGkgPCBuOyBpKyspIHtcbiAgICAgICAgcmVzdWx0LnB1c2goY2FsbGJhY2suY2FsbChjb250ZXh0IHx8IG51bGwsIG9iamVjdFtpXSwgaSkpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBmb3IgKHZhciBrZXkgaW4gb2JqZWN0KSB7XG4gICAgICAgIGlmICghb2JqZWN0Lmhhc093blByb3BlcnR5KGtleSkpIGNvbnRpbnVlO1xuICAgICAgICByZXN1bHQucHVzaChjYWxsYmFjay5jYWxsKGNvbnRleHQgfHwgbnVsbCwga2V5LCBvYmplY3Rba2V5XSkpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9LFxuXG4gIGZpbHRlcjogZnVuY3Rpb24oYXJyYXksIGNhbGxiYWNrLCBjb250ZXh0KSB7XG4gICAgaWYgKGFycmF5LmZpbHRlcikgcmV0dXJuIGFycmF5LmZpbHRlcihjYWxsYmFjaywgY29udGV4dCk7XG4gICAgdmFyIHJlc3VsdCA9IFtdO1xuICAgIGZvciAodmFyIGkgPSAwLCBuID0gYXJyYXkubGVuZ3RoOyBpIDwgbjsgaSsrKSB7XG4gICAgICBpZiAoY2FsbGJhY2suY2FsbChjb250ZXh0IHx8IG51bGwsIGFycmF5W2ldLCBpKSlcbiAgICAgICAgcmVzdWx0LnB1c2goYXJyYXlbaV0pO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9LFxuXG4gIGFzeW5jRWFjaDogZnVuY3Rpb24obGlzdCwgaXRlcmF0b3IsIGNhbGxiYWNrLCBjb250ZXh0KSB7XG4gICAgdmFyIG4gICAgICAgPSBsaXN0Lmxlbmd0aCxcbiAgICAgICAgaSAgICAgICA9IC0xLFxuICAgICAgICBjYWxscyAgID0gMCxcbiAgICAgICAgbG9vcGluZyA9IGZhbHNlO1xuXG4gICAgdmFyIGl0ZXJhdGUgPSBmdW5jdGlvbigpIHtcbiAgICAgIGNhbGxzIC09IDE7XG4gICAgICBpICs9IDE7XG4gICAgICBpZiAoaSA9PT0gbikgcmV0dXJuIGNhbGxiYWNrICYmIGNhbGxiYWNrLmNhbGwoY29udGV4dCk7XG4gICAgICBpdGVyYXRvcihsaXN0W2ldLCByZXN1bWUpO1xuICAgIH07XG5cbiAgICB2YXIgbG9vcCA9IGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKGxvb3BpbmcpIHJldHVybjtcbiAgICAgIGxvb3BpbmcgPSB0cnVlO1xuICAgICAgd2hpbGUgKGNhbGxzID4gMCkgaXRlcmF0ZSgpO1xuICAgICAgbG9vcGluZyA9IGZhbHNlO1xuICAgIH07XG5cbiAgICB2YXIgcmVzdW1lID0gZnVuY3Rpb24oKSB7XG4gICAgICBjYWxscyArPSAxO1xuICAgICAgbG9vcCgpO1xuICAgIH07XG4gICAgcmVzdW1lKCk7XG4gIH1cbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBmb3JFYWNoID0gQXJyYXkucHJvdG90eXBlLmZvckVhY2gsXG4gICAgaGFzT3duICA9IE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHk7XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24odGFyZ2V0KSB7XG4gIGZvckVhY2guY2FsbChhcmd1bWVudHMsIGZ1bmN0aW9uKHNvdXJjZSwgaSkge1xuICAgIGlmIChpID09PSAwKSByZXR1cm47XG5cbiAgICBmb3IgKHZhciBrZXkgaW4gc291cmNlKSB7XG4gICAgICBpZiAoaGFzT3duLmNhbGwoc291cmNlLCBrZXkpKSB0YXJnZXRba2V5XSA9IHNvdXJjZVtrZXldO1xuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHRhcmdldDtcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBFdmVudCA9IHtcbiAgX3JlZ2lzdHJ5OiBbXSxcblxuICBvbjogZnVuY3Rpb24oZWxlbWVudCwgZXZlbnROYW1lLCBjYWxsYmFjaywgY29udGV4dCkge1xuICAgIHZhciB3cmFwcGVkID0gZnVuY3Rpb24oKSB7IGNhbGxiYWNrLmNhbGwoY29udGV4dCkgfTtcblxuICAgIGlmIChlbGVtZW50LmFkZEV2ZW50TGlzdGVuZXIpXG4gICAgICBlbGVtZW50LmFkZEV2ZW50TGlzdGVuZXIoZXZlbnROYW1lLCB3cmFwcGVkLCBmYWxzZSk7XG4gICAgZWxzZVxuICAgICAgZWxlbWVudC5hdHRhY2hFdmVudCgnb24nICsgZXZlbnROYW1lLCB3cmFwcGVkKTtcblxuICAgIHRoaXMuX3JlZ2lzdHJ5LnB1c2goe1xuICAgICAgX2VsZW1lbnQ6ICAgZWxlbWVudCxcbiAgICAgIF90eXBlOiAgICAgIGV2ZW50TmFtZSxcbiAgICAgIF9jYWxsYmFjazogIGNhbGxiYWNrLFxuICAgICAgX2NvbnRleHQ6ICAgICBjb250ZXh0LFxuICAgICAgX2hhbmRsZXI6ICAgd3JhcHBlZFxuICAgIH0pO1xuICB9LFxuXG4gIGRldGFjaDogZnVuY3Rpb24oZWxlbWVudCwgZXZlbnROYW1lLCBjYWxsYmFjaywgY29udGV4dCkge1xuICAgIHZhciBpID0gdGhpcy5fcmVnaXN0cnkubGVuZ3RoLCByZWdpc3RlcjtcbiAgICB3aGlsZSAoaS0tKSB7XG4gICAgICByZWdpc3RlciA9IHRoaXMuX3JlZ2lzdHJ5W2ldO1xuXG4gICAgICBpZiAoKGVsZW1lbnQgICAgJiYgZWxlbWVudCAgICAhPT0gcmVnaXN0ZXIuX2VsZW1lbnQpICB8fFxuICAgICAgICAgIChldmVudE5hbWUgICYmIGV2ZW50TmFtZSAgIT09IHJlZ2lzdGVyLl90eXBlKSAgICAgfHxcbiAgICAgICAgICAoY2FsbGJhY2sgICAmJiBjYWxsYmFjayAgICE9PSByZWdpc3Rlci5fY2FsbGJhY2spIHx8XG4gICAgICAgICAgKGNvbnRleHQgICAgJiYgY29udGV4dCAgICAhPT0gcmVnaXN0ZXIuX2NvbnRleHQpKVxuICAgICAgICBjb250aW51ZTtcblxuICAgICAgaWYgKHJlZ2lzdGVyLl9lbGVtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIpXG4gICAgICAgIHJlZ2lzdGVyLl9lbGVtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIocmVnaXN0ZXIuX3R5cGUsIHJlZ2lzdGVyLl9oYW5kbGVyLCBmYWxzZSk7XG4gICAgICBlbHNlXG4gICAgICAgIHJlZ2lzdGVyLl9lbGVtZW50LmRldGFjaEV2ZW50KCdvbicgKyByZWdpc3Rlci5fdHlwZSwgcmVnaXN0ZXIuX2hhbmRsZXIpO1xuXG4gICAgICB0aGlzLl9yZWdpc3RyeS5zcGxpY2UoaSwxKTtcbiAgICAgIHJlZ2lzdGVyID0gbnVsbDtcbiAgICB9XG4gIH1cbn07XG5cbmlmIChnbG9iYWwub251bmxvYWQgIT09IHVuZGVmaW5lZClcbiAgRXZlbnQub24oZ2xvYmFsLCAndW5sb2FkJywgRXZlbnQuZGV0YWNoLCBFdmVudCk7XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICBFdmVudDogRXZlbnRcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBhc3NpZ24gPSByZXF1aXJlKCcuL2Fzc2lnbicpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHBhcmVudCwgbWV0aG9kcykge1xuICBpZiAodHlwZW9mIHBhcmVudCAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIG1ldGhvZHMgPSBwYXJlbnQ7XG4gICAgcGFyZW50ICA9IE9iamVjdDtcbiAgfVxuXG4gIHZhciBrbGFzcyA9IGZ1bmN0aW9uKCkge1xuICAgIGlmICghdGhpcy5pbml0aWFsaXplKSByZXR1cm4gdGhpcztcbiAgICByZXR1cm4gdGhpcy5pbml0aWFsaXplLmFwcGx5KHRoaXMsIGFyZ3VtZW50cykgfHwgdGhpcztcbiAgfTtcblxuICB2YXIgYnJpZGdlID0gZnVuY3Rpb24oKSB7fTtcbiAgYnJpZGdlLnByb3RvdHlwZSA9IHBhcmVudC5wcm90b3R5cGU7XG5cbiAga2xhc3MucHJvdG90eXBlID0gbmV3IGJyaWRnZSgpO1xuICBhc3NpZ24oa2xhc3MucHJvdG90eXBlLCBtZXRob2RzKTtcblxuICByZXR1cm4ga2xhc3M7XG59O1xuIiwibW9kdWxlLmV4cG9ydHMgPSB7XG4gIFZFUlNJT046ICAgICAgICAgICcxLjQuMCcsXG5cbiAgQkFZRVVYX1ZFUlNJT046ICAgJzEuMCcsXG4gIElEX0xFTkdUSDogICAgICAgIDE2MCxcbiAgSlNPTlBfQ0FMTEJBQ0s6ICAgJ2pzb25wY2FsbGJhY2snLFxuICBDT05ORUNUSU9OX1RZUEVTOiBbJ2xvbmctcG9sbGluZycsICdjcm9zcy1vcmlnaW4tbG9uZy1wb2xsaW5nJywgJ2NhbGxiYWNrLXBvbGxpbmcnLCAnd2Vic29ja2V0JywgJ2V2ZW50c291cmNlJywgJ2luLXByb2Nlc3MnXSxcblxuICBNQU5EQVRPUllfQ09OTkVDVElPTl9UWVBFUzogWydsb25nLXBvbGxpbmcnLCAnY2FsbGJhY2stcG9sbGluZycsICdpbi1wcm9jZXNzJ11cbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbm1vZHVsZS5leHBvcnRzID0ge307XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBjb3B5T2JqZWN0ID0gZnVuY3Rpb24ob2JqZWN0KSB7XG4gIHZhciBjbG9uZSwgaSwga2V5O1xuICBpZiAob2JqZWN0IGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICBjbG9uZSA9IFtdO1xuICAgIGkgPSBvYmplY3QubGVuZ3RoO1xuICAgIHdoaWxlIChpLS0pIGNsb25lW2ldID0gY29weU9iamVjdChvYmplY3RbaV0pO1xuICAgIHJldHVybiBjbG9uZTtcbiAgfSBlbHNlIGlmICh0eXBlb2Ygb2JqZWN0ID09PSAnb2JqZWN0Jykge1xuICAgIGNsb25lID0gKG9iamVjdCA9PT0gbnVsbCkgPyBudWxsIDoge307XG4gICAgZm9yIChrZXkgaW4gb2JqZWN0KSBjbG9uZVtrZXldID0gY29weU9iamVjdChvYmplY3Rba2V5XSk7XG4gICAgcmV0dXJuIGNsb25lO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBvYmplY3Q7XG4gIH1cbn07XG5cbm1vZHVsZS5leHBvcnRzID0gY29weU9iamVjdDtcbiIsIi8qXG5Db3B5cmlnaHQgSm95ZW50LCBJbmMuIGFuZCBvdGhlciBOb2RlIGNvbnRyaWJ1dG9ycy4gQWxsIHJpZ2h0cyByZXNlcnZlZC5cblBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHkgb2ZcbnRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWwgaW5cbnRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG9cbnVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzXG5vZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG9cbnNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczpcblxuVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWQgaW4gYWxsXG5jb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuXG5USEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTIE9SXG5JTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSxcbkZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOIE5PIEVWRU5UIFNIQUxMIFRIRVxuQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUlxuTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSxcbk9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFXG5TT0ZUV0FSRS5cbiovXG5cbnZhciBpc0FycmF5ID0gdHlwZW9mIEFycmF5LmlzQXJyYXkgPT09ICdmdW5jdGlvbidcbiAgICA/IEFycmF5LmlzQXJyYXlcbiAgICA6IGZ1bmN0aW9uICh4cykge1xuICAgICAgICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHhzKSA9PT0gJ1tvYmplY3QgQXJyYXldJ1xuICAgIH1cbjtcbmZ1bmN0aW9uIGluZGV4T2YgKHhzLCB4KSB7XG4gICAgaWYgKHhzLmluZGV4T2YpIHJldHVybiB4cy5pbmRleE9mKHgpO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgeHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKHggPT09IHhzW2ldKSByZXR1cm4gaTtcbiAgICB9XG4gICAgcmV0dXJuIC0xO1xufVxuXG5mdW5jdGlvbiBFdmVudEVtaXR0ZXIoKSB7fVxubW9kdWxlLmV4cG9ydHMgPSBFdmVudEVtaXR0ZXI7XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuZW1pdCA9IGZ1bmN0aW9uKHR5cGUpIHtcbiAgLy8gSWYgdGhlcmUgaXMgbm8gJ2Vycm9yJyBldmVudCBsaXN0ZW5lciB0aGVuIHRocm93LlxuICBpZiAodHlwZSA9PT0gJ2Vycm9yJykge1xuICAgIGlmICghdGhpcy5fZXZlbnRzIHx8ICF0aGlzLl9ldmVudHMuZXJyb3IgfHxcbiAgICAgICAgKGlzQXJyYXkodGhpcy5fZXZlbnRzLmVycm9yKSAmJiAhdGhpcy5fZXZlbnRzLmVycm9yLmxlbmd0aCkpXG4gICAge1xuICAgICAgaWYgKGFyZ3VtZW50c1sxXSBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgICAgIHRocm93IGFyZ3VtZW50c1sxXTsgLy8gVW5oYW5kbGVkICdlcnJvcicgZXZlbnRcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIlVuY2F1Z2h0LCB1bnNwZWNpZmllZCAnZXJyb3InIGV2ZW50LlwiKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICBpZiAoIXRoaXMuX2V2ZW50cykgcmV0dXJuIGZhbHNlO1xuICB2YXIgaGFuZGxlciA9IHRoaXMuX2V2ZW50c1t0eXBlXTtcbiAgaWYgKCFoYW5kbGVyKSByZXR1cm4gZmFsc2U7XG5cbiAgaWYgKHR5cGVvZiBoYW5kbGVyID09ICdmdW5jdGlvbicpIHtcbiAgICBzd2l0Y2ggKGFyZ3VtZW50cy5sZW5ndGgpIHtcbiAgICAgIC8vIGZhc3QgY2FzZXNcbiAgICAgIGNhc2UgMTpcbiAgICAgICAgaGFuZGxlci5jYWxsKHRoaXMpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgMjpcbiAgICAgICAgaGFuZGxlci5jYWxsKHRoaXMsIGFyZ3VtZW50c1sxXSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAzOlxuICAgICAgICBoYW5kbGVyLmNhbGwodGhpcywgYXJndW1lbnRzWzFdLCBhcmd1bWVudHNbMl0pO1xuICAgICAgICBicmVhaztcbiAgICAgIC8vIHNsb3dlclxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdmFyIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpO1xuICAgICAgICBoYW5kbGVyLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcblxuICB9IGVsc2UgaWYgKGlzQXJyYXkoaGFuZGxlcikpIHtcbiAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSk7XG5cbiAgICB2YXIgbGlzdGVuZXJzID0gaGFuZGxlci5zbGljZSgpO1xuICAgIGZvciAodmFyIGkgPSAwLCBsID0gbGlzdGVuZXJzLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgbGlzdGVuZXJzW2ldLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcblxuICB9IGVsc2Uge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufTtcblxuLy8gRXZlbnRFbWl0dGVyIGlzIGRlZmluZWQgaW4gc3JjL25vZGVfZXZlbnRzLmNjXG4vLyBFdmVudEVtaXR0ZXIucHJvdG90eXBlLmVtaXQoKSBpcyBhbHNvIGRlZmluZWQgdGhlcmUuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLmFkZExpc3RlbmVyID0gZnVuY3Rpb24odHlwZSwgbGlzdGVuZXIpIHtcbiAgaWYgKCdmdW5jdGlvbicgIT09IHR5cGVvZiBsaXN0ZW5lcikge1xuICAgIHRocm93IG5ldyBFcnJvcignYWRkTGlzdGVuZXIgb25seSB0YWtlcyBpbnN0YW5jZXMgb2YgRnVuY3Rpb24nKTtcbiAgfVxuXG4gIGlmICghdGhpcy5fZXZlbnRzKSB0aGlzLl9ldmVudHMgPSB7fTtcblxuICAvLyBUbyBhdm9pZCByZWN1cnNpb24gaW4gdGhlIGNhc2UgdGhhdCB0eXBlID09IFwibmV3TGlzdGVuZXJzXCIhIEJlZm9yZVxuICAvLyBhZGRpbmcgaXQgdG8gdGhlIGxpc3RlbmVycywgZmlyc3QgZW1pdCBcIm5ld0xpc3RlbmVyc1wiLlxuICB0aGlzLmVtaXQoJ25ld0xpc3RlbmVyJywgdHlwZSwgbGlzdGVuZXIpO1xuXG4gIGlmICghdGhpcy5fZXZlbnRzW3R5cGVdKSB7XG4gICAgLy8gT3B0aW1pemUgdGhlIGNhc2Ugb2Ygb25lIGxpc3RlbmVyLiBEb24ndCBuZWVkIHRoZSBleHRyYSBhcnJheSBvYmplY3QuXG4gICAgdGhpcy5fZXZlbnRzW3R5cGVdID0gbGlzdGVuZXI7XG4gIH0gZWxzZSBpZiAoaXNBcnJheSh0aGlzLl9ldmVudHNbdHlwZV0pKSB7XG4gICAgLy8gSWYgd2UndmUgYWxyZWFkeSBnb3QgYW4gYXJyYXksIGp1c3QgYXBwZW5kLlxuICAgIHRoaXMuX2V2ZW50c1t0eXBlXS5wdXNoKGxpc3RlbmVyKTtcbiAgfSBlbHNlIHtcbiAgICAvLyBBZGRpbmcgdGhlIHNlY29uZCBlbGVtZW50LCBuZWVkIHRvIGNoYW5nZSB0byBhcnJheS5cbiAgICB0aGlzLl9ldmVudHNbdHlwZV0gPSBbdGhpcy5fZXZlbnRzW3R5cGVdLCBsaXN0ZW5lcl07XG4gIH1cblxuICByZXR1cm4gdGhpcztcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUub24gPSBFdmVudEVtaXR0ZXIucHJvdG90eXBlLmFkZExpc3RlbmVyO1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLm9uY2UgPSBmdW5jdGlvbih0eXBlLCBsaXN0ZW5lcikge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHNlbGYub24odHlwZSwgZnVuY3Rpb24gZygpIHtcbiAgICBzZWxmLnJlbW92ZUxpc3RlbmVyKHR5cGUsIGcpO1xuICAgIGxpc3RlbmVyLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gIH0pO1xuXG4gIHJldHVybiB0aGlzO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5yZW1vdmVMaXN0ZW5lciA9IGZ1bmN0aW9uKHR5cGUsIGxpc3RlbmVyKSB7XG4gIGlmICgnZnVuY3Rpb24nICE9PSB0eXBlb2YgbGlzdGVuZXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3JlbW92ZUxpc3RlbmVyIG9ubHkgdGFrZXMgaW5zdGFuY2VzIG9mIEZ1bmN0aW9uJyk7XG4gIH1cblxuICAvLyBkb2VzIG5vdCB1c2UgbGlzdGVuZXJzKCksIHNvIG5vIHNpZGUgZWZmZWN0IG9mIGNyZWF0aW5nIF9ldmVudHNbdHlwZV1cbiAgaWYgKCF0aGlzLl9ldmVudHMgfHwgIXRoaXMuX2V2ZW50c1t0eXBlXSkgcmV0dXJuIHRoaXM7XG5cbiAgdmFyIGxpc3QgPSB0aGlzLl9ldmVudHNbdHlwZV07XG5cbiAgaWYgKGlzQXJyYXkobGlzdCkpIHtcbiAgICB2YXIgaSA9IGluZGV4T2YobGlzdCwgbGlzdGVuZXIpO1xuICAgIGlmIChpIDwgMCkgcmV0dXJuIHRoaXM7XG4gICAgbGlzdC5zcGxpY2UoaSwgMSk7XG4gICAgaWYgKGxpc3QubGVuZ3RoID09IDApXG4gICAgICBkZWxldGUgdGhpcy5fZXZlbnRzW3R5cGVdO1xuICB9IGVsc2UgaWYgKHRoaXMuX2V2ZW50c1t0eXBlXSA9PT0gbGlzdGVuZXIpIHtcbiAgICBkZWxldGUgdGhpcy5fZXZlbnRzW3R5cGVdO1xuICB9XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLnJlbW92ZUFsbExpc3RlbmVycyA9IGZ1bmN0aW9uKHR5cGUpIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDApIHtcbiAgICB0aGlzLl9ldmVudHMgPSB7fTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8vIGRvZXMgbm90IHVzZSBsaXN0ZW5lcnMoKSwgc28gbm8gc2lkZSBlZmZlY3Qgb2YgY3JlYXRpbmcgX2V2ZW50c1t0eXBlXVxuICBpZiAodHlwZSAmJiB0aGlzLl9ldmVudHMgJiYgdGhpcy5fZXZlbnRzW3R5cGVdKSB0aGlzLl9ldmVudHNbdHlwZV0gPSBudWxsO1xuICByZXR1cm4gdGhpcztcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUubGlzdGVuZXJzID0gZnVuY3Rpb24odHlwZSkge1xuICBpZiAoIXRoaXMuX2V2ZW50cykgdGhpcy5fZXZlbnRzID0ge307XG4gIGlmICghdGhpcy5fZXZlbnRzW3R5cGVdKSB0aGlzLl9ldmVudHNbdHlwZV0gPSBbXTtcbiAgaWYgKCFpc0FycmF5KHRoaXMuX2V2ZW50c1t0eXBlXSkpIHtcbiAgICB0aGlzLl9ldmVudHNbdHlwZV0gPSBbdGhpcy5fZXZlbnRzW3R5cGVdXTtcbiAgfVxuICByZXR1cm4gdGhpcy5fZXZlbnRzW3R5cGVdO1xufTtcbiIsIid1c2Ugc3RyaWN0JztcblxudmFyIGFzYXAgPSByZXF1aXJlKCdhc2FwJyk7XG5cbnZhciBQRU5ESU5HICAgPSAtMSxcbiAgICBGVUxGSUxMRUQgPSAgMCxcbiAgICBSRUpFQ1RFRCAgPSAgMTtcblxudmFyIFByb21pc2UgPSBmdW5jdGlvbih0YXNrKSB7XG4gIHRoaXMuX3N0YXRlID0gUEVORElORztcbiAgdGhpcy5fdmFsdWUgPSBudWxsO1xuICB0aGlzLl9kZWZlciA9IFtdO1xuXG4gIGV4ZWN1dGUodGhpcywgdGFzayk7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS50aGVuID0gZnVuY3Rpb24ob25GdWxmaWxsZWQsIG9uUmVqZWN0ZWQpIHtcbiAgdmFyIHByb21pc2UgPSBuZXcgUHJvbWlzZSgpO1xuXG4gIHZhciBkZWZlcnJlZCA9IHtcbiAgICBwcm9taXNlOiAgICAgcHJvbWlzZSxcbiAgICBvbkZ1bGZpbGxlZDogb25GdWxmaWxsZWQsXG4gICAgb25SZWplY3RlZDogIG9uUmVqZWN0ZWRcbiAgfTtcblxuICBpZiAodGhpcy5fc3RhdGUgPT09IFBFTkRJTkcpXG4gICAgdGhpcy5fZGVmZXIucHVzaChkZWZlcnJlZCk7XG4gIGVsc2VcbiAgICBwcm9wYWdhdGUodGhpcywgZGVmZXJyZWQpO1xuXG4gIHJldHVybiBwcm9taXNlO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGVbJ2NhdGNoJ10gPSBmdW5jdGlvbihvblJlamVjdGVkKSB7XG4gIHJldHVybiB0aGlzLnRoZW4obnVsbCwgb25SZWplY3RlZCk7XG59O1xuXG52YXIgZXhlY3V0ZSA9IGZ1bmN0aW9uKHByb21pc2UsIHRhc2spIHtcbiAgaWYgKHR5cGVvZiB0YXNrICE9PSAnZnVuY3Rpb24nKSByZXR1cm47XG5cbiAgdmFyIGNhbGxzID0gMDtcblxuICB2YXIgcmVzb2x2ZVByb21pc2UgPSBmdW5jdGlvbih2YWx1ZSkge1xuICAgIGlmIChjYWxscysrID09PSAwKSByZXNvbHZlKHByb21pc2UsIHZhbHVlKTtcbiAgfTtcblxuICB2YXIgcmVqZWN0UHJvbWlzZSA9IGZ1bmN0aW9uKHJlYXNvbikge1xuICAgIGlmIChjYWxscysrID09PSAwKSByZWplY3QocHJvbWlzZSwgcmVhc29uKTtcbiAgfTtcblxuICB0cnkge1xuICAgIHRhc2socmVzb2x2ZVByb21pc2UsIHJlamVjdFByb21pc2UpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJlamVjdFByb21pc2UoZXJyb3IpO1xuICB9XG59O1xuXG52YXIgcHJvcGFnYXRlID0gZnVuY3Rpb24ocHJvbWlzZSwgZGVmZXJyZWQpIHtcbiAgdmFyIHN0YXRlICAgPSBwcm9taXNlLl9zdGF0ZSxcbiAgICAgIHZhbHVlICAgPSBwcm9taXNlLl92YWx1ZSxcbiAgICAgIG5leHQgICAgPSBkZWZlcnJlZC5wcm9taXNlLFxuICAgICAgaGFuZGxlciA9IFtkZWZlcnJlZC5vbkZ1bGZpbGxlZCwgZGVmZXJyZWQub25SZWplY3RlZF1bc3RhdGVdLFxuICAgICAgcGFzcyAgICA9IFtyZXNvbHZlLCByZWplY3RdW3N0YXRlXTtcblxuICBpZiAodHlwZW9mIGhhbmRsZXIgIT09ICdmdW5jdGlvbicpXG4gICAgcmV0dXJuIHBhc3MobmV4dCwgdmFsdWUpO1xuXG4gIGFzYXAoZnVuY3Rpb24oKSB7XG4gICAgdHJ5IHtcbiAgICAgIHJlc29sdmUobmV4dCwgaGFuZGxlcih2YWx1ZSkpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICByZWplY3QobmV4dCwgZXJyb3IpO1xuICAgIH1cbiAgfSk7XG59O1xuXG52YXIgcmVzb2x2ZSA9IGZ1bmN0aW9uKHByb21pc2UsIHZhbHVlKSB7XG4gIGlmIChwcm9taXNlID09PSB2YWx1ZSlcbiAgICByZXR1cm4gcmVqZWN0KHByb21pc2UsIG5ldyBUeXBlRXJyb3IoJ1JlY3Vyc2l2ZSBwcm9taXNlIGNoYWluIGRldGVjdGVkJykpO1xuXG4gIHZhciB0aGVuO1xuXG4gIHRyeSB7XG4gICAgdGhlbiA9IGdldFRoZW4odmFsdWUpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiByZWplY3QocHJvbWlzZSwgZXJyb3IpO1xuICB9XG5cbiAgaWYgKCF0aGVuKSByZXR1cm4gZnVsZmlsbChwcm9taXNlLCB2YWx1ZSk7XG5cbiAgZXhlY3V0ZShwcm9taXNlLCBmdW5jdGlvbihyZXNvbHZlUHJvbWlzZSwgcmVqZWN0UHJvbWlzZSkge1xuICAgIHRoZW4uY2FsbCh2YWx1ZSwgcmVzb2x2ZVByb21pc2UsIHJlamVjdFByb21pc2UpO1xuICB9KTtcbn07XG5cbnZhciBnZXRUaGVuID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgdmFyIHR5cGUgPSB0eXBlb2YgdmFsdWUsXG4gICAgICB0aGVuID0gKHR5cGUgPT09ICdvYmplY3QnIHx8IHR5cGUgPT09ICdmdW5jdGlvbicpICYmIHZhbHVlICYmIHZhbHVlLnRoZW47XG5cbiAgcmV0dXJuICh0eXBlb2YgdGhlbiA9PT0gJ2Z1bmN0aW9uJylcbiAgICAgICAgID8gdGhlblxuICAgICAgICAgOiBudWxsO1xufTtcblxudmFyIGZ1bGZpbGwgPSBmdW5jdGlvbihwcm9taXNlLCB2YWx1ZSkge1xuICBzZXR0bGUocHJvbWlzZSwgRlVMRklMTEVELCB2YWx1ZSk7XG59O1xuXG52YXIgcmVqZWN0ID0gZnVuY3Rpb24ocHJvbWlzZSwgcmVhc29uKSB7XG4gIHNldHRsZShwcm9taXNlLCBSRUpFQ1RFRCwgcmVhc29uKTtcbn07XG5cbnZhciBzZXR0bGUgPSBmdW5jdGlvbihwcm9taXNlLCBzdGF0ZSwgdmFsdWUpIHtcbiAgdmFyIGRlZmVyID0gcHJvbWlzZS5fZGVmZXIsIGkgPSAwO1xuXG4gIHByb21pc2UuX3N0YXRlID0gc3RhdGU7XG4gIHByb21pc2UuX3ZhbHVlID0gdmFsdWU7XG4gIHByb21pc2UuX2RlZmVyID0gbnVsbDtcblxuICBpZiAoZGVmZXIubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIHdoaWxlIChpIDwgZGVmZXIubGVuZ3RoKSBwcm9wYWdhdGUocHJvbWlzZSwgZGVmZXJbaSsrXSk7XG59O1xuXG5Qcm9taXNlLnJlc29sdmUgPSBmdW5jdGlvbih2YWx1ZSkge1xuICB0cnkge1xuICAgIGlmIChnZXRUaGVuKHZhbHVlKSkgcmV0dXJuIHZhbHVlO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBQcm9taXNlLnJlamVjdChlcnJvcik7XG4gIH1cblxuICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KSB7IHJlc29sdmUodmFsdWUpIH0pO1xufTtcblxuUHJvbWlzZS5yZWplY3QgPSBmdW5jdGlvbihyZWFzb24pIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkgeyByZWplY3QocmVhc29uKSB9KTtcbn07XG5cblByb21pc2UuYWxsID0gZnVuY3Rpb24ocHJvbWlzZXMpIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xuICAgIHZhciBsaXN0ID0gW10sIG4gPSBwcm9taXNlcy5sZW5ndGgsIGk7XG5cbiAgICBpZiAobiA9PT0gMCkgcmV0dXJuIHJlc29sdmUobGlzdCk7XG5cbiAgICB2YXIgcHVzaCA9IGZ1bmN0aW9uKHByb21pc2UsIGkpIHtcbiAgICAgIFByb21pc2UucmVzb2x2ZShwcm9taXNlKS50aGVuKGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICAgIGxpc3RbaV0gPSB2YWx1ZTtcbiAgICAgICAgaWYgKC0tbiA9PT0gMCkgcmVzb2x2ZShsaXN0KTtcbiAgICAgIH0sIHJlamVjdCk7XG4gICAgfTtcblxuICAgIGZvciAoaSA9IDA7IGkgPCBuOyBpKyspIHB1c2gocHJvbWlzZXNbaV0sIGkpO1xuICB9KTtcbn07XG5cblByb21pc2UucmFjZSA9IGZ1bmN0aW9uKHByb21pc2VzKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlLCByZWplY3QpIHtcbiAgICBmb3IgKHZhciBpID0gMCwgbiA9IHByb21pc2VzLmxlbmd0aDsgaSA8IG47IGkrKylcbiAgICAgIFByb21pc2UucmVzb2x2ZShwcm9taXNlc1tpXSkudGhlbihyZXNvbHZlLCByZWplY3QpO1xuICB9KTtcbn07XG5cblByb21pc2UuZGVmZXJyZWQgPSBmdW5jdGlvbigpIHtcbiAgdmFyIHR1cGxlID0ge307XG5cbiAgdHVwbGUucHJvbWlzZSA9IG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xuICAgIHR1cGxlLnJlc29sdmUgPSByZXNvbHZlO1xuICAgIHR1cGxlLnJlamVjdCAgPSByZWplY3Q7XG4gIH0pO1xuICByZXR1cm4gdHVwbGU7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IFByb21pc2U7XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBDbGFzcyA9IHJlcXVpcmUoJy4vY2xhc3MnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBDbGFzcyh7XG4gIGluaXRpYWxpemU6IGZ1bmN0aW9uKCkge1xuICAgIHRoaXMuX2luZGV4ID0ge307XG4gIH0sXG5cbiAgYWRkOiBmdW5jdGlvbihpdGVtKSB7XG4gICAgdmFyIGtleSA9IChpdGVtLmlkICE9PSB1bmRlZmluZWQpID8gaXRlbS5pZCA6IGl0ZW07XG4gICAgaWYgKHRoaXMuX2luZGV4Lmhhc093blByb3BlcnR5KGtleSkpIHJldHVybiBmYWxzZTtcbiAgICB0aGlzLl9pbmRleFtrZXldID0gaXRlbTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSxcblxuICBmb3JFYWNoOiBmdW5jdGlvbihibG9jaywgY29udGV4dCkge1xuICAgIGZvciAodmFyIGtleSBpbiB0aGlzLl9pbmRleCkge1xuICAgICAgaWYgKHRoaXMuX2luZGV4Lmhhc093blByb3BlcnR5KGtleSkpXG4gICAgICAgIGJsb2NrLmNhbGwoY29udGV4dCwgdGhpcy5faW5kZXhba2V5XSk7XG4gICAgfVxuICB9LFxuXG4gIGlzRW1wdHk6IGZ1bmN0aW9uKCkge1xuICAgIGZvciAodmFyIGtleSBpbiB0aGlzLl9pbmRleCkge1xuICAgICAgaWYgKHRoaXMuX2luZGV4Lmhhc093blByb3BlcnR5KGtleSkpIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH0sXG5cbiAgbWVtYmVyOiBmdW5jdGlvbihpdGVtKSB7XG4gICAgZm9yICh2YXIga2V5IGluIHRoaXMuX2luZGV4KSB7XG4gICAgICBpZiAodGhpcy5faW5kZXhba2V5XSA9PT0gaXRlbSkgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfSxcblxuICByZW1vdmU6IGZ1bmN0aW9uKGl0ZW0pIHtcbiAgICB2YXIga2V5ID0gKGl0ZW0uaWQgIT09IHVuZGVmaW5lZCkgPyBpdGVtLmlkIDogaXRlbTtcbiAgICB2YXIgcmVtb3ZlZCA9IHRoaXMuX2luZGV4W2tleV07XG4gICAgZGVsZXRlIHRoaXMuX2luZGV4W2tleV07XG4gICAgcmV0dXJuIHJlbW92ZWQ7XG4gIH0sXG5cbiAgdG9BcnJheTogZnVuY3Rpb24oKSB7XG4gICAgdmFyIGFycmF5ID0gW107XG4gICAgdGhpcy5mb3JFYWNoKGZ1bmN0aW9uKGl0ZW0pIHsgYXJyYXkucHVzaChpdGVtKSB9KTtcbiAgICByZXR1cm4gYXJyYXk7XG4gIH1cbn0pO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG4vLyBodHRwOi8vYXNzYW5rYS5uZXQvY29udGVudC90ZWNoLzIwMDkvMDkvMDIvanNvbjItanMtdnMtcHJvdG90eXBlL1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKG9iamVjdCkge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkob2JqZWN0LCBmdW5jdGlvbihrZXksIHZhbHVlKSB7XG4gICAgcmV0dXJuICh0aGlzW2tleV0gaW5zdGFuY2VvZiBBcnJheSkgPyB0aGlzW2tleV0gOiB2YWx1ZTtcbiAgfSk7XG59O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgaXNVUkk6IGZ1bmN0aW9uKHVyaSkge1xuICAgIHJldHVybiB1cmkgJiYgdXJpLnByb3RvY29sICYmIHVyaS5ob3N0ICYmIHVyaS5wYXRoO1xuICB9LFxuXG4gIGlzU2FtZU9yaWdpbjogZnVuY3Rpb24odXJpKSB7XG4gICAgcmV0dXJuIHVyaS5wcm90b2NvbCA9PT0gbG9jYXRpb24ucHJvdG9jb2wgJiZcbiAgICAgICAgICAgdXJpLmhvc3RuYW1lID09PSBsb2NhdGlvbi5ob3N0bmFtZSAmJlxuICAgICAgICAgICB1cmkucG9ydCAgICAgPT09IGxvY2F0aW9uLnBvcnQ7XG4gIH0sXG5cbiAgcGFyc2U6IGZ1bmN0aW9uKHVybCkge1xuICAgIGlmICh0eXBlb2YgdXJsICE9PSAnc3RyaW5nJykgcmV0dXJuIHVybDtcbiAgICB2YXIgdXJpID0ge30sIHBhcnRzLCBxdWVyeSwgcGFpcnMsIGksIG4sIGRhdGE7XG5cbiAgICB2YXIgY29uc3VtZSA9IGZ1bmN0aW9uKG5hbWUsIHBhdHRlcm4pIHtcbiAgICAgIHVybCA9IHVybC5yZXBsYWNlKHBhdHRlcm4sIGZ1bmN0aW9uKG1hdGNoKSB7XG4gICAgICAgIHVyaVtuYW1lXSA9IG1hdGNoO1xuICAgICAgICByZXR1cm4gJyc7XG4gICAgICB9KTtcbiAgICAgIHVyaVtuYW1lXSA9IHVyaVtuYW1lXSB8fCAnJztcbiAgICB9O1xuXG4gICAgY29uc3VtZSgncHJvdG9jb2wnLCAvXlthLXpdK1xcOi9pKTtcbiAgICBjb25zdW1lKCdob3N0JywgICAgIC9eXFwvXFwvW15cXC9cXD8jXSsvKTtcblxuICAgIGlmICghL15cXC8vLnRlc3QodXJsKSAmJiAhdXJpLmhvc3QpXG4gICAgICB1cmwgPSBsb2NhdGlvbi5wYXRobmFtZS5yZXBsYWNlKC9bXlxcL10qJC8sICcnKSArIHVybDtcblxuICAgIGNvbnN1bWUoJ3BhdGhuYW1lJywgL15bXlxcPyNdKi8pO1xuICAgIGNvbnN1bWUoJ3NlYXJjaCcsICAgL15cXD9bXiNdKi8pO1xuICAgIGNvbnN1bWUoJ2hhc2gnLCAgICAgL14jLiovKTtcblxuICAgIHVyaS5wcm90b2NvbCA9IHVyaS5wcm90b2NvbCB8fCBsb2NhdGlvbi5wcm90b2NvbDtcblxuICAgIGlmICh1cmkuaG9zdCkge1xuICAgICAgdXJpLmhvc3QgPSB1cmkuaG9zdC5zdWJzdHIoMik7XG5cbiAgICAgIGlmICgvQC8udGVzdCh1cmkuaG9zdCkpIHtcbiAgICAgICAgdXJpLmF1dGggPSB1cmkuaG9zdC5zcGxpdCgnQCcpWzBdO1xuICAgICAgICB1cmkuaG9zdCA9IHVyaS5ob3N0LnNwbGl0KCdAJylbMV07XG4gICAgICB9XG4gICAgICBwYXJ0cyAgICAgICAgPSB1cmkuaG9zdC5tYXRjaCgvXlxcWyhbXlxcXV0rKVxcXXxeW146XSsvKTtcbiAgICAgIHVyaS5ob3N0bmFtZSA9IHBhcnRzWzFdIHx8IHBhcnRzWzBdO1xuICAgICAgdXJpLnBvcnQgICAgID0gKHVyaS5ob3N0Lm1hdGNoKC86KFxcZCspJC8pIHx8IFtdKVsxXSB8fCAnJztcbiAgICB9IGVsc2Uge1xuICAgICAgdXJpLmhvc3QgICAgID0gbG9jYXRpb24uaG9zdDtcbiAgICAgIHVyaS5ob3N0bmFtZSA9IGxvY2F0aW9uLmhvc3RuYW1lO1xuICAgICAgdXJpLnBvcnQgICAgID0gbG9jYXRpb24ucG9ydDtcbiAgICB9XG5cbiAgICB1cmkucGF0aG5hbWUgPSB1cmkucGF0aG5hbWUgfHwgJy8nO1xuICAgIHVyaS5wYXRoID0gdXJpLnBhdGhuYW1lICsgdXJpLnNlYXJjaDtcblxuICAgIHF1ZXJ5ID0gdXJpLnNlYXJjaC5yZXBsYWNlKC9eXFw/LywgJycpO1xuICAgIHBhaXJzID0gcXVlcnkgPyBxdWVyeS5zcGxpdCgnJicpIDogW107XG4gICAgZGF0YSAgPSB7fTtcblxuICAgIGZvciAoaSA9IDAsIG4gPSBwYWlycy5sZW5ndGg7IGkgPCBuOyBpKyspIHtcbiAgICAgIHBhcnRzID0gcGFpcnNbaV0uc3BsaXQoJz0nKTtcbiAgICAgIGRhdGFbZGVjb2RlVVJJQ29tcG9uZW50KHBhcnRzWzBdIHx8ICcnKV0gPSBkZWNvZGVVUklDb21wb25lbnQocGFydHNbMV0gfHwgJycpO1xuICAgIH1cblxuICAgIHVyaS5xdWVyeSA9IGRhdGE7XG5cbiAgICB1cmkuaHJlZiA9IHRoaXMuc3RyaW5naWZ5KHVyaSk7XG4gICAgcmV0dXJuIHVyaTtcbiAgfSxcblxuICBzdHJpbmdpZnk6IGZ1bmN0aW9uKHVyaSkge1xuICAgIHZhciBhdXRoICAgPSB1cmkuYXV0aCA/IHVyaS5hdXRoICsgJ0AnIDogJycsXG4gICAgICAgIHN0cmluZyA9IHVyaS5wcm90b2NvbCArICcvLycgKyBhdXRoICsgdXJpLmhvc3Q7XG5cbiAgICBzdHJpbmcgKz0gdXJpLnBhdGhuYW1lICsgdGhpcy5xdWVyeVN0cmluZyh1cmkucXVlcnkpICsgKHVyaS5oYXNoIHx8ICcnKTtcblxuICAgIHJldHVybiBzdHJpbmc7XG4gIH0sXG5cbiAgcXVlcnlTdHJpbmc6IGZ1bmN0aW9uKHF1ZXJ5KSB7XG4gICAgdmFyIHBhaXJzID0gW107XG4gICAgZm9yICh2YXIga2V5IGluIHF1ZXJ5KSB7XG4gICAgICBpZiAoIXF1ZXJ5Lmhhc093blByb3BlcnR5KGtleSkpIGNvbnRpbnVlO1xuICAgICAgcGFpcnMucHVzaChlbmNvZGVVUklDb21wb25lbnQoa2V5KSArICc9JyArIGVuY29kZVVSSUNvbXBvbmVudChxdWVyeVtrZXldKSk7XG4gICAgfVxuICAgIGlmIChwYWlycy5sZW5ndGggPT09IDApIHJldHVybiAnJztcbiAgICByZXR1cm4gJz8nICsgcGFpcnMuam9pbignJicpO1xuICB9XG59O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgYXJyYXkgPSByZXF1aXJlKCcuL2FycmF5Jyk7XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24ob3B0aW9ucywgdmFsaWRLZXlzKSB7XG4gIGZvciAodmFyIGtleSBpbiBvcHRpb25zKSB7XG4gICAgaWYgKGFycmF5LmluZGV4T2YodmFsaWRLZXlzLCBrZXkpIDwgMClcbiAgICAgIHRocm93IG5ldyBFcnJvcignVW5yZWNvZ25pemVkIG9wdGlvbjogJyArIGtleSk7XG4gIH1cbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBXUyA9IGdsb2JhbC5Nb3pXZWJTb2NrZXQgfHwgZ2xvYmFsLldlYlNvY2tldDtcblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIGNyZWF0ZTogZnVuY3Rpb24odXJsLCBwcm90b2NvbHMsIG9wdGlvbnMpIHtcbiAgICBpZiAodHlwZW9mIFdTICE9PSAnZnVuY3Rpb24nKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gbmV3IFdTKHVybCk7XG4gIH1cbn07XG4iLCIvLyBzaGltIGZvciB1c2luZyBwcm9jZXNzIGluIGJyb3dzZXJcbnZhciBwcm9jZXNzID0gbW9kdWxlLmV4cG9ydHMgPSB7fTtcblxuLy8gY2FjaGVkIGZyb20gd2hhdGV2ZXIgZ2xvYmFsIGlzIHByZXNlbnQgc28gdGhhdCB0ZXN0IHJ1bm5lcnMgdGhhdCBzdHViIGl0XG4vLyBkb24ndCBicmVhayB0aGluZ3MuICBCdXQgd2UgbmVlZCB0byB3cmFwIGl0IGluIGEgdHJ5IGNhdGNoIGluIGNhc2UgaXQgaXNcbi8vIHdyYXBwZWQgaW4gc3RyaWN0IG1vZGUgY29kZSB3aGljaCBkb2Vzbid0IGRlZmluZSBhbnkgZ2xvYmFscy4gIEl0J3MgaW5zaWRlIGFcbi8vIGZ1bmN0aW9uIGJlY2F1c2UgdHJ5L2NhdGNoZXMgZGVvcHRpbWl6ZSBpbiBjZXJ0YWluIGVuZ2luZXMuXG5cbnZhciBjYWNoZWRTZXRUaW1lb3V0O1xudmFyIGNhY2hlZENsZWFyVGltZW91dDtcblxuZnVuY3Rpb24gZGVmYXVsdFNldFRpbW91dCgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3NldFRpbWVvdXQgaGFzIG5vdCBiZWVuIGRlZmluZWQnKTtcbn1cbmZ1bmN0aW9uIGRlZmF1bHRDbGVhclRpbWVvdXQgKCkge1xuICAgIHRocm93IG5ldyBFcnJvcignY2xlYXJUaW1lb3V0IGhhcyBub3QgYmVlbiBkZWZpbmVkJyk7XG59XG4oZnVuY3Rpb24gKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGlmICh0eXBlb2Ygc2V0VGltZW91dCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2FjaGVkU2V0VGltZW91dCA9IHNldFRpbWVvdXQ7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjYWNoZWRTZXRUaW1lb3V0ID0gZGVmYXVsdFNldFRpbW91dDtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY2FjaGVkU2V0VGltZW91dCA9IGRlZmF1bHRTZXRUaW1vdXQ7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIGlmICh0eXBlb2YgY2xlYXJUaW1lb3V0ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjYWNoZWRDbGVhclRpbWVvdXQgPSBjbGVhclRpbWVvdXQ7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjYWNoZWRDbGVhclRpbWVvdXQgPSBkZWZhdWx0Q2xlYXJUaW1lb3V0O1xuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjYWNoZWRDbGVhclRpbWVvdXQgPSBkZWZhdWx0Q2xlYXJUaW1lb3V0O1xuICAgIH1cbn0gKCkpXG5mdW5jdGlvbiBydW5UaW1lb3V0KGZ1bikge1xuICAgIGlmIChjYWNoZWRTZXRUaW1lb3V0ID09PSBzZXRUaW1lb3V0KSB7XG4gICAgICAgIC8vbm9ybWFsIGVudmlyb21lbnRzIGluIHNhbmUgc2l0dWF0aW9uc1xuICAgICAgICByZXR1cm4gc2V0VGltZW91dChmdW4sIDApO1xuICAgIH1cbiAgICAvLyBpZiBzZXRUaW1lb3V0IHdhc24ndCBhdmFpbGFibGUgYnV0IHdhcyBsYXR0ZXIgZGVmaW5lZFxuICAgIGlmICgoY2FjaGVkU2V0VGltZW91dCA9PT0gZGVmYXVsdFNldFRpbW91dCB8fCAhY2FjaGVkU2V0VGltZW91dCkgJiYgc2V0VGltZW91dCkge1xuICAgICAgICBjYWNoZWRTZXRUaW1lb3V0ID0gc2V0VGltZW91dDtcbiAgICAgICAgcmV0dXJuIHNldFRpbWVvdXQoZnVuLCAwKTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgLy8gd2hlbiB3aGVuIHNvbWVib2R5IGhhcyBzY3Jld2VkIHdpdGggc2V0VGltZW91dCBidXQgbm8gSS5FLiBtYWRkbmVzc1xuICAgICAgICByZXR1cm4gY2FjaGVkU2V0VGltZW91dChmdW4sIDApO1xuICAgIH0gY2F0Y2goZSl7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICAvLyBXaGVuIHdlIGFyZSBpbiBJLkUuIGJ1dCB0aGUgc2NyaXB0IGhhcyBiZWVuIGV2YWxlZCBzbyBJLkUuIGRvZXNuJ3QgdHJ1c3QgdGhlIGdsb2JhbCBvYmplY3Qgd2hlbiBjYWxsZWQgbm9ybWFsbHlcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWRTZXRUaW1lb3V0LmNhbGwobnVsbCwgZnVuLCAwKTtcbiAgICAgICAgfSBjYXRjaChlKXtcbiAgICAgICAgICAgIC8vIHNhbWUgYXMgYWJvdmUgYnV0IHdoZW4gaXQncyBhIHZlcnNpb24gb2YgSS5FLiB0aGF0IG11c3QgaGF2ZSB0aGUgZ2xvYmFsIG9iamVjdCBmb3IgJ3RoaXMnLCBob3BmdWxseSBvdXIgY29udGV4dCBjb3JyZWN0IG90aGVyd2lzZSBpdCB3aWxsIHRocm93IGEgZ2xvYmFsIGVycm9yXG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkU2V0VGltZW91dC5jYWxsKHRoaXMsIGZ1biwgMCk7XG4gICAgICAgIH1cbiAgICB9XG5cblxufVxuZnVuY3Rpb24gcnVuQ2xlYXJUaW1lb3V0KG1hcmtlcikge1xuICAgIGlmIChjYWNoZWRDbGVhclRpbWVvdXQgPT09IGNsZWFyVGltZW91dCkge1xuICAgICAgICAvL25vcm1hbCBlbnZpcm9tZW50cyBpbiBzYW5lIHNpdHVhdGlvbnNcbiAgICAgICAgcmV0dXJuIGNsZWFyVGltZW91dChtYXJrZXIpO1xuICAgIH1cbiAgICAvLyBpZiBjbGVhclRpbWVvdXQgd2Fzbid0IGF2YWlsYWJsZSBidXQgd2FzIGxhdHRlciBkZWZpbmVkXG4gICAgaWYgKChjYWNoZWRDbGVhclRpbWVvdXQgPT09IGRlZmF1bHRDbGVhclRpbWVvdXQgfHwgIWNhY2hlZENsZWFyVGltZW91dCkgJiYgY2xlYXJUaW1lb3V0KSB7XG4gICAgICAgIGNhY2hlZENsZWFyVGltZW91dCA9IGNsZWFyVGltZW91dDtcbiAgICAgICAgcmV0dXJuIGNsZWFyVGltZW91dChtYXJrZXIpO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgICAvLyB3aGVuIHdoZW4gc29tZWJvZHkgaGFzIHNjcmV3ZWQgd2l0aCBzZXRUaW1lb3V0IGJ1dCBubyBJLkUuIG1hZGRuZXNzXG4gICAgICAgIHJldHVybiBjYWNoZWRDbGVhclRpbWVvdXQobWFya2VyKTtcbiAgICB9IGNhdGNoIChlKXtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIC8vIFdoZW4gd2UgYXJlIGluIEkuRS4gYnV0IHRoZSBzY3JpcHQgaGFzIGJlZW4gZXZhbGVkIHNvIEkuRS4gZG9lc24ndCAgdHJ1c3QgdGhlIGdsb2JhbCBvYmplY3Qgd2hlbiBjYWxsZWQgbm9ybWFsbHlcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWRDbGVhclRpbWVvdXQuY2FsbChudWxsLCBtYXJrZXIpO1xuICAgICAgICB9IGNhdGNoIChlKXtcbiAgICAgICAgICAgIC8vIHNhbWUgYXMgYWJvdmUgYnV0IHdoZW4gaXQncyBhIHZlcnNpb24gb2YgSS5FLiB0aGF0IG11c3QgaGF2ZSB0aGUgZ2xvYmFsIG9iamVjdCBmb3IgJ3RoaXMnLCBob3BmdWxseSBvdXIgY29udGV4dCBjb3JyZWN0IG90aGVyd2lzZSBpdCB3aWxsIHRocm93IGEgZ2xvYmFsIGVycm9yLlxuICAgICAgICAgICAgLy8gU29tZSB2ZXJzaW9ucyBvZiBJLkUuIGhhdmUgZGlmZmVyZW50IHJ1bGVzIGZvciBjbGVhclRpbWVvdXQgdnMgc2V0VGltZW91dFxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZENsZWFyVGltZW91dC5jYWxsKHRoaXMsIG1hcmtlcik7XG4gICAgICAgIH1cbiAgICB9XG5cblxuXG59XG52YXIgcXVldWUgPSBbXTtcbnZhciBkcmFpbmluZyA9IGZhbHNlO1xudmFyIGN1cnJlbnRRdWV1ZTtcbnZhciBxdWV1ZUluZGV4ID0gLTE7XG5cbmZ1bmN0aW9uIGNsZWFuVXBOZXh0VGljaygpIHtcbiAgICBpZiAoIWRyYWluaW5nIHx8ICFjdXJyZW50UXVldWUpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBkcmFpbmluZyA9IGZhbHNlO1xuICAgIGlmIChjdXJyZW50UXVldWUubGVuZ3RoKSB7XG4gICAgICAgIHF1ZXVlID0gY3VycmVudFF1ZXVlLmNvbmNhdChxdWV1ZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcXVldWVJbmRleCA9IC0xO1xuICAgIH1cbiAgICBpZiAocXVldWUubGVuZ3RoKSB7XG4gICAgICAgIGRyYWluUXVldWUoKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGRyYWluUXVldWUoKSB7XG4gICAgaWYgKGRyYWluaW5nKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdmFyIHRpbWVvdXQgPSBydW5UaW1lb3V0KGNsZWFuVXBOZXh0VGljayk7XG4gICAgZHJhaW5pbmcgPSB0cnVlO1xuXG4gICAgdmFyIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB3aGlsZShsZW4pIHtcbiAgICAgICAgY3VycmVudFF1ZXVlID0gcXVldWU7XG4gICAgICAgIHF1ZXVlID0gW107XG4gICAgICAgIHdoaWxlICgrK3F1ZXVlSW5kZXggPCBsZW4pIHtcbiAgICAgICAgICAgIGlmIChjdXJyZW50UXVldWUpIHtcbiAgICAgICAgICAgICAgICBjdXJyZW50UXVldWVbcXVldWVJbmRleF0ucnVuKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcXVldWVJbmRleCA9IC0xO1xuICAgICAgICBsZW4gPSBxdWV1ZS5sZW5ndGg7XG4gICAgfVxuICAgIGN1cnJlbnRRdWV1ZSA9IG51bGw7XG4gICAgZHJhaW5pbmcgPSBmYWxzZTtcbiAgICBydW5DbGVhclRpbWVvdXQodGltZW91dCk7XG59XG5cbnByb2Nlc3MubmV4dFRpY2sgPSBmdW5jdGlvbiAoZnVuKSB7XG4gICAgdmFyIGFyZ3MgPSBuZXcgQXJyYXkoYXJndW1lbnRzLmxlbmd0aCAtIDEpO1xuICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID4gMSkge1xuICAgICAgICBmb3IgKHZhciBpID0gMTsgaSA8IGFyZ3VtZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgYXJnc1tpIC0gMV0gPSBhcmd1bWVudHNbaV07XG4gICAgICAgIH1cbiAgICB9XG4gICAgcXVldWUucHVzaChuZXcgSXRlbShmdW4sIGFyZ3MpKTtcbiAgICBpZiAocXVldWUubGVuZ3RoID09PSAxICYmICFkcmFpbmluZykge1xuICAgICAgICBydW5UaW1lb3V0KGRyYWluUXVldWUpO1xuICAgIH1cbn07XG5cbi8vIHY4IGxpa2VzIHByZWRpY3RpYmxlIG9iamVjdHNcbmZ1bmN0aW9uIEl0ZW0oZnVuLCBhcnJheSkge1xuICAgIHRoaXMuZnVuID0gZnVuO1xuICAgIHRoaXMuYXJyYXkgPSBhcnJheTtcbn1cbkl0ZW0ucHJvdG90eXBlLnJ1biA9IGZ1bmN0aW9uICgpIHtcbiAgICB0aGlzLmZ1bi5hcHBseShudWxsLCB0aGlzLmFycmF5KTtcbn07XG5wcm9jZXNzLnRpdGxlID0gJ2Jyb3dzZXInO1xucHJvY2Vzcy5icm93c2VyID0gdHJ1ZTtcbnByb2Nlc3MuZW52ID0ge307XG5wcm9jZXNzLmFyZ3YgPSBbXTtcbnByb2Nlc3MudmVyc2lvbiA9ICcnOyAvLyBlbXB0eSBzdHJpbmcgdG8gYXZvaWQgcmVnZXhwIGlzc3Vlc1xucHJvY2Vzcy52ZXJzaW9ucyA9IHt9O1xuXG5mdW5jdGlvbiBub29wKCkge31cblxucHJvY2Vzcy5vbiA9IG5vb3A7XG5wcm9jZXNzLmFkZExpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3Mub25jZSA9IG5vb3A7XG5wcm9jZXNzLm9mZiA9IG5vb3A7XG5wcm9jZXNzLnJlbW92ZUxpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlQWxsTGlzdGVuZXJzID0gbm9vcDtcbnByb2Nlc3MuZW1pdCA9IG5vb3A7XG5wcm9jZXNzLnByZXBlbmRMaXN0ZW5lciA9IG5vb3A7XG5wcm9jZXNzLnByZXBlbmRPbmNlTGlzdGVuZXIgPSBub29wO1xuXG5wcm9jZXNzLmxpc3RlbmVycyA9IGZ1bmN0aW9uIChuYW1lKSB7IHJldHVybiBbXSB9XG5cbnByb2Nlc3MuYmluZGluZyA9IGZ1bmN0aW9uIChuYW1lKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwcm9jZXNzLmJpbmRpbmcgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcblxucHJvY2Vzcy5jd2QgPSBmdW5jdGlvbiAoKSB7IHJldHVybiAnLycgfTtcbnByb2Nlc3MuY2hkaXIgPSBmdW5jdGlvbiAoZGlyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwcm9jZXNzLmNoZGlyIGlzIG5vdCBzdXBwb3J0ZWQnKTtcbn07XG5wcm9jZXNzLnVtYXNrID0gZnVuY3Rpb24oKSB7IHJldHVybiAwOyB9O1xuIl19

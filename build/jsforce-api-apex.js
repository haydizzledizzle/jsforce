(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g=(g.jsforce||(g.jsforce = {}));g=(g.modules||(g.modules = {}));g=(g.api||(g.api = {}));g.Apex = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
/**
 * @file Manages Salesforce Apex REST endpoint calls
 * @author Shinichi Tomita <shinichi.tomita@gmail.com>
 */

'use strict';

var jsforce = window.jsforce.require('./core');

/**
 * API class for Apex REST endpoint call
 *
 * @class
 * @param {Connection} conn Connection
 */
var Apex = function(conn) {
  this._conn = conn;
};

/**
 * @private
 */
Apex.prototype._baseUrl = function() {
  return this._conn.instanceUrl + "/services/apexrest";
};

/**
 * @private
 */
Apex.prototype._createRequestParams = function(method, path, body, options) {
  var params = {
    method: method,
    url: this._baseUrl() + path
  },
  _headers = {};
  if(options && 'object' === typeof options['headers']){
    _headers = options['headers'];
  }
  if (!/^(GET|DELETE)$/i.test(method)) {
    _headers["Content-Type"] = "application/json";
  }
  params.headers = _headers;
  if (body) {
    var contentType = params.headers["Content-Type"];
    if (!contentType || contentType === "application/json") {
      params.body = JSON.stringify(body);
    } else {
      params.body = body;
    }
  }
  return params;
};

/**
 * Call Apex REST service in GET request
 *
 * @param {String} path - URL path to Apex REST service
 * @param {Object} options - Holds headers and other meta data for the request.
 * @param {Callback.<Object>} [callback] - Callback function
 * @returns {Promise.<Object>}
 */
Apex.prototype.get = function(path, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  return this._conn.request(this._createRequestParams('GET', path, undefined, options)).thenCall(callback);
};

/**
 * Call Apex REST service in POST request
 *
 * @param {String} path - URL path to Apex REST service
 * @param {Object} [body] - Request body
 * @param {Object} options - Holds headers and other meta data for the request.
 * @param {Callback.<Object>} [callback] - Callback function
 * @returns {Promise.<Object>}
 */
Apex.prototype.post = function(path, body, options, callback) {
  if (typeof body === 'function') {
    callback = body;
    body = undefined;
    options = undefined;
  }
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  var params = this._createRequestParams('POST', path, body, options);
  return this._conn.request(params).thenCall(callback);
};

/**
 * Call Apex REST service in PUT request
 *
 * @param {String} path - URL path to Apex REST service
 * @param {Object} [body] - Request body
 * @param {Object} [options] - Holds headers and other meta data for the request.
 * @param {Callback.<Object>} [callback] - Callback function
 * @returns {Promise.<Object>}
 */
Apex.prototype.put = function(path, body, options, callback) {
  if (typeof body === 'function') {
    callback = body;
    body = undefined;
    options = undefined;
  }
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  var params = this._createRequestParams('PUT', path, body, options);
  return this._conn.request(params).thenCall(callback);
};

/**
 * Call Apex REST service in PATCH request
 *
 * @param {String} path - URL path to Apex REST service
 * @param {Object} [body] - Request body
 * @param {Object} [options] - Holds headers and other meta data for the request.
 * @param {Callback.<Object>} [callback] - Callback function
 * @returns {Promise.<Object>}
 */
Apex.prototype.patch = function(path, body, options, callback) {
  if (typeof body === 'function') {
    callback = body;
    body = undefined;
    options = undefined;
  }
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  var params = this._createRequestParams('PATCH', path, body, options);
  return this._conn.request(params).thenCall(callback);
};

/**
 * Synonym of Apex#delete()
 *
 * @method Apex#del
 *
 * @param {String} path - URL path to Apex REST service
 * @param {Callback.<Object>} [callback] - Callback function
 * @returns {Promise.<Object>}
 */
/**
 * Call Apex REST service in DELETE request
 *
 * @method Apex#delete
 *
 * @param {String} path - URL path to Apex REST service
 * @param {Object} [options] - Holds headers and other meta data for the request.
 * @param {Callback.<Object>} [callback] - Callback function
 * @returns {Promise.<Object>}
 */
Apex.prototype.del =
  Apex.prototype["delete"] = function(path, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  return this._conn.request(this._createRequestParams('DELETE', path, undefined, options)).thenCall(callback);
};


/*--------------------------------------------*/
/*
 * Register hook in connection instantiation for dynamically adding this API module features
 */
jsforce.on('connection:new', function(conn) {
  conn.apex = new Apex(conn);
});


module.exports = Apex;

},{}]},{},[1])(1)
});

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJsaWIvYXBpL2FwZXguanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uKCl7ZnVuY3Rpb24gcihlLG4sdCl7ZnVuY3Rpb24gbyhpLGYpe2lmKCFuW2ldKXtpZighZVtpXSl7dmFyIGM9XCJmdW5jdGlvblwiPT10eXBlb2YgcmVxdWlyZSYmcmVxdWlyZTtpZighZiYmYylyZXR1cm4gYyhpLCEwKTtpZih1KXJldHVybiB1KGksITApO3ZhciBhPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIraStcIidcIik7dGhyb3cgYS5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGF9dmFyIHA9bltpXT17ZXhwb3J0czp7fX07ZVtpXVswXS5jYWxsKHAuZXhwb3J0cyxmdW5jdGlvbihyKXt2YXIgbj1lW2ldWzFdW3JdO3JldHVybiBvKG58fHIpfSxwLHAuZXhwb3J0cyxyLGUsbix0KX1yZXR1cm4gbltpXS5leHBvcnRzfWZvcih2YXIgdT1cImZ1bmN0aW9uXCI9PXR5cGVvZiByZXF1aXJlJiZyZXF1aXJlLGk9MDtpPHQubGVuZ3RoO2krKylvKHRbaV0pO3JldHVybiBvfXJldHVybiByfSkoKSIsIi8qKlxyXG4gKiBAZmlsZSBNYW5hZ2VzIFNhbGVzZm9yY2UgQXBleCBSRVNUIGVuZHBvaW50IGNhbGxzXHJcbiAqIEBhdXRob3IgU2hpbmljaGkgVG9taXRhIDxzaGluaWNoaS50b21pdGFAZ21haWwuY29tPlxyXG4gKi9cclxuXHJcbid1c2Ugc3RyaWN0JztcclxuXHJcbnZhciBqc2ZvcmNlID0gd2luZG93LmpzZm9yY2UucmVxdWlyZSgnLi9jb3JlJyk7XHJcblxyXG4vKipcclxuICogQVBJIGNsYXNzIGZvciBBcGV4IFJFU1QgZW5kcG9pbnQgY2FsbFxyXG4gKlxyXG4gKiBAY2xhc3NcclxuICogQHBhcmFtIHtDb25uZWN0aW9ufSBjb25uIENvbm5lY3Rpb25cclxuICovXHJcbnZhciBBcGV4ID0gZnVuY3Rpb24oY29ubikge1xyXG4gIHRoaXMuX2Nvbm4gPSBjb25uO1xyXG59O1xyXG5cclxuLyoqXHJcbiAqIEBwcml2YXRlXHJcbiAqL1xyXG5BcGV4LnByb3RvdHlwZS5fYmFzZVVybCA9IGZ1bmN0aW9uKCkge1xyXG4gIHJldHVybiB0aGlzLl9jb25uLmluc3RhbmNlVXJsICsgXCIvc2VydmljZXMvYXBleHJlc3RcIjtcclxufTtcclxuXHJcbi8qKlxyXG4gKiBAcHJpdmF0ZVxyXG4gKi9cclxuQXBleC5wcm90b3R5cGUuX2NyZWF0ZVJlcXVlc3RQYXJhbXMgPSBmdW5jdGlvbihtZXRob2QsIHBhdGgsIGJvZHksIG9wdGlvbnMpIHtcclxuICB2YXIgcGFyYW1zID0ge1xyXG4gICAgbWV0aG9kOiBtZXRob2QsXHJcbiAgICB1cmw6IHRoaXMuX2Jhc2VVcmwoKSArIHBhdGhcclxuICB9LFxyXG4gIF9oZWFkZXJzID0ge307XHJcbiAgaWYob3B0aW9ucyAmJiAnb2JqZWN0JyA9PT0gdHlwZW9mIG9wdGlvbnNbJ2hlYWRlcnMnXSl7XHJcbiAgICBfaGVhZGVycyA9IG9wdGlvbnNbJ2hlYWRlcnMnXTtcclxuICB9XHJcbiAgaWYgKCEvXihHRVR8REVMRVRFKSQvaS50ZXN0KG1ldGhvZCkpIHtcclxuICAgIF9oZWFkZXJzW1wiQ29udGVudC1UeXBlXCJdID0gXCJhcHBsaWNhdGlvbi9qc29uXCI7XHJcbiAgfVxyXG4gIHBhcmFtcy5oZWFkZXJzID0gX2hlYWRlcnM7XHJcbiAgaWYgKGJvZHkpIHtcclxuICAgIHZhciBjb250ZW50VHlwZSA9IHBhcmFtcy5oZWFkZXJzW1wiQ29udGVudC1UeXBlXCJdO1xyXG4gICAgaWYgKCFjb250ZW50VHlwZSB8fCBjb250ZW50VHlwZSA9PT0gXCJhcHBsaWNhdGlvbi9qc29uXCIpIHtcclxuICAgICAgcGFyYW1zLmJvZHkgPSBKU09OLnN0cmluZ2lmeShib2R5KTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIHBhcmFtcy5ib2R5ID0gYm9keTtcclxuICAgIH1cclxuICB9XHJcbiAgcmV0dXJuIHBhcmFtcztcclxufTtcclxuXHJcbi8qKlxyXG4gKiBDYWxsIEFwZXggUkVTVCBzZXJ2aWNlIGluIEdFVCByZXF1ZXN0XHJcbiAqXHJcbiAqIEBwYXJhbSB7U3RyaW5nfSBwYXRoIC0gVVJMIHBhdGggdG8gQXBleCBSRVNUIHNlcnZpY2VcclxuICogQHBhcmFtIHtPYmplY3R9IG9wdGlvbnMgLSBIb2xkcyBoZWFkZXJzIGFuZCBvdGhlciBtZXRhIGRhdGEgZm9yIHRoZSByZXF1ZXN0LlxyXG4gKiBAcGFyYW0ge0NhbGxiYWNrLjxPYmplY3Q+fSBbY2FsbGJhY2tdIC0gQ2FsbGJhY2sgZnVuY3Rpb25cclxuICogQHJldHVybnMge1Byb21pc2UuPE9iamVjdD59XHJcbiAqL1xyXG5BcGV4LnByb3RvdHlwZS5nZXQgPSBmdW5jdGlvbihwYXRoLCBvcHRpb25zLCBjYWxsYmFjaykge1xyXG4gIGlmICh0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xyXG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xyXG4gICAgb3B0aW9ucyA9IHVuZGVmaW5lZDtcclxuICB9XHJcbiAgcmV0dXJuIHRoaXMuX2Nvbm4ucmVxdWVzdCh0aGlzLl9jcmVhdGVSZXF1ZXN0UGFyYW1zKCdHRVQnLCBwYXRoLCB1bmRlZmluZWQsIG9wdGlvbnMpKS50aGVuQ2FsbChjYWxsYmFjayk7XHJcbn07XHJcblxyXG4vKipcclxuICogQ2FsbCBBcGV4IFJFU1Qgc2VydmljZSBpbiBQT1NUIHJlcXVlc3RcclxuICpcclxuICogQHBhcmFtIHtTdHJpbmd9IHBhdGggLSBVUkwgcGF0aCB0byBBcGV4IFJFU1Qgc2VydmljZVxyXG4gKiBAcGFyYW0ge09iamVjdH0gW2JvZHldIC0gUmVxdWVzdCBib2R5XHJcbiAqIEBwYXJhbSB7T2JqZWN0fSBvcHRpb25zIC0gSG9sZHMgaGVhZGVycyBhbmQgb3RoZXIgbWV0YSBkYXRhIGZvciB0aGUgcmVxdWVzdC5cclxuICogQHBhcmFtIHtDYWxsYmFjay48T2JqZWN0Pn0gW2NhbGxiYWNrXSAtIENhbGxiYWNrIGZ1bmN0aW9uXHJcbiAqIEByZXR1cm5zIHtQcm9taXNlLjxPYmplY3Q+fVxyXG4gKi9cclxuQXBleC5wcm90b3R5cGUucG9zdCA9IGZ1bmN0aW9uKHBhdGgsIGJvZHksIG9wdGlvbnMsIGNhbGxiYWNrKSB7XHJcbiAgaWYgKHR5cGVvZiBib2R5ID09PSAnZnVuY3Rpb24nKSB7XHJcbiAgICBjYWxsYmFjayA9IGJvZHk7XHJcbiAgICBib2R5ID0gdW5kZWZpbmVkO1xyXG4gICAgb3B0aW9ucyA9IHVuZGVmaW5lZDtcclxuICB9XHJcbiAgaWYgKHR5cGVvZiBvcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XHJcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XHJcbiAgICBvcHRpb25zID0gdW5kZWZpbmVkO1xyXG4gIH1cclxuICB2YXIgcGFyYW1zID0gdGhpcy5fY3JlYXRlUmVxdWVzdFBhcmFtcygnUE9TVCcsIHBhdGgsIGJvZHksIG9wdGlvbnMpO1xyXG4gIHJldHVybiB0aGlzLl9jb25uLnJlcXVlc3QocGFyYW1zKS50aGVuQ2FsbChjYWxsYmFjayk7XHJcbn07XHJcblxyXG4vKipcclxuICogQ2FsbCBBcGV4IFJFU1Qgc2VydmljZSBpbiBQVVQgcmVxdWVzdFxyXG4gKlxyXG4gKiBAcGFyYW0ge1N0cmluZ30gcGF0aCAtIFVSTCBwYXRoIHRvIEFwZXggUkVTVCBzZXJ2aWNlXHJcbiAqIEBwYXJhbSB7T2JqZWN0fSBbYm9keV0gLSBSZXF1ZXN0IGJvZHlcclxuICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXSAtIEhvbGRzIGhlYWRlcnMgYW5kIG90aGVyIG1ldGEgZGF0YSBmb3IgdGhlIHJlcXVlc3QuXHJcbiAqIEBwYXJhbSB7Q2FsbGJhY2suPE9iamVjdD59IFtjYWxsYmFja10gLSBDYWxsYmFjayBmdW5jdGlvblxyXG4gKiBAcmV0dXJucyB7UHJvbWlzZS48T2JqZWN0Pn1cclxuICovXHJcbkFwZXgucHJvdG90eXBlLnB1dCA9IGZ1bmN0aW9uKHBhdGgsIGJvZHksIG9wdGlvbnMsIGNhbGxiYWNrKSB7XHJcbiAgaWYgKHR5cGVvZiBib2R5ID09PSAnZnVuY3Rpb24nKSB7XHJcbiAgICBjYWxsYmFjayA9IGJvZHk7XHJcbiAgICBib2R5ID0gdW5kZWZpbmVkO1xyXG4gICAgb3B0aW9ucyA9IHVuZGVmaW5lZDtcclxuICB9XHJcbiAgaWYgKHR5cGVvZiBvcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XHJcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XHJcbiAgICBvcHRpb25zID0gdW5kZWZpbmVkO1xyXG4gIH1cclxuICB2YXIgcGFyYW1zID0gdGhpcy5fY3JlYXRlUmVxdWVzdFBhcmFtcygnUFVUJywgcGF0aCwgYm9keSwgb3B0aW9ucyk7XHJcbiAgcmV0dXJuIHRoaXMuX2Nvbm4ucmVxdWVzdChwYXJhbXMpLnRoZW5DYWxsKGNhbGxiYWNrKTtcclxufTtcclxuXHJcbi8qKlxyXG4gKiBDYWxsIEFwZXggUkVTVCBzZXJ2aWNlIGluIFBBVENIIHJlcXVlc3RcclxuICpcclxuICogQHBhcmFtIHtTdHJpbmd9IHBhdGggLSBVUkwgcGF0aCB0byBBcGV4IFJFU1Qgc2VydmljZVxyXG4gKiBAcGFyYW0ge09iamVjdH0gW2JvZHldIC0gUmVxdWVzdCBib2R5XHJcbiAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBIb2xkcyBoZWFkZXJzIGFuZCBvdGhlciBtZXRhIGRhdGEgZm9yIHRoZSByZXF1ZXN0LlxyXG4gKiBAcGFyYW0ge0NhbGxiYWNrLjxPYmplY3Q+fSBbY2FsbGJhY2tdIC0gQ2FsbGJhY2sgZnVuY3Rpb25cclxuICogQHJldHVybnMge1Byb21pc2UuPE9iamVjdD59XHJcbiAqL1xyXG5BcGV4LnByb3RvdHlwZS5wYXRjaCA9IGZ1bmN0aW9uKHBhdGgsIGJvZHksIG9wdGlvbnMsIGNhbGxiYWNrKSB7XHJcbiAgaWYgKHR5cGVvZiBib2R5ID09PSAnZnVuY3Rpb24nKSB7XHJcbiAgICBjYWxsYmFjayA9IGJvZHk7XHJcbiAgICBib2R5ID0gdW5kZWZpbmVkO1xyXG4gICAgb3B0aW9ucyA9IHVuZGVmaW5lZDtcclxuICB9XHJcbiAgaWYgKHR5cGVvZiBvcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XHJcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XHJcbiAgICBvcHRpb25zID0gdW5kZWZpbmVkO1xyXG4gIH1cclxuICB2YXIgcGFyYW1zID0gdGhpcy5fY3JlYXRlUmVxdWVzdFBhcmFtcygnUEFUQ0gnLCBwYXRoLCBib2R5LCBvcHRpb25zKTtcclxuICByZXR1cm4gdGhpcy5fY29ubi5yZXF1ZXN0KHBhcmFtcykudGhlbkNhbGwoY2FsbGJhY2spO1xyXG59O1xyXG5cclxuLyoqXHJcbiAqIFN5bm9ueW0gb2YgQXBleCNkZWxldGUoKVxyXG4gKlxyXG4gKiBAbWV0aG9kIEFwZXgjZGVsXHJcbiAqXHJcbiAqIEBwYXJhbSB7U3RyaW5nfSBwYXRoIC0gVVJMIHBhdGggdG8gQXBleCBSRVNUIHNlcnZpY2VcclxuICogQHBhcmFtIHtDYWxsYmFjay48T2JqZWN0Pn0gW2NhbGxiYWNrXSAtIENhbGxiYWNrIGZ1bmN0aW9uXHJcbiAqIEByZXR1cm5zIHtQcm9taXNlLjxPYmplY3Q+fVxyXG4gKi9cclxuLyoqXHJcbiAqIENhbGwgQXBleCBSRVNUIHNlcnZpY2UgaW4gREVMRVRFIHJlcXVlc3RcclxuICpcclxuICogQG1ldGhvZCBBcGV4I2RlbGV0ZVxyXG4gKlxyXG4gKiBAcGFyYW0ge1N0cmluZ30gcGF0aCAtIFVSTCBwYXRoIHRvIEFwZXggUkVTVCBzZXJ2aWNlXHJcbiAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBIb2xkcyBoZWFkZXJzIGFuZCBvdGhlciBtZXRhIGRhdGEgZm9yIHRoZSByZXF1ZXN0LlxyXG4gKiBAcGFyYW0ge0NhbGxiYWNrLjxPYmplY3Q+fSBbY2FsbGJhY2tdIC0gQ2FsbGJhY2sgZnVuY3Rpb25cclxuICogQHJldHVybnMge1Byb21pc2UuPE9iamVjdD59XHJcbiAqL1xyXG5BcGV4LnByb3RvdHlwZS5kZWwgPVxyXG4gIEFwZXgucHJvdG90eXBlW1wiZGVsZXRlXCJdID0gZnVuY3Rpb24ocGF0aCwgb3B0aW9ucywgY2FsbGJhY2spIHtcclxuICBpZiAodHlwZW9mIG9wdGlvbnMgPT09ICdmdW5jdGlvbicpIHtcclxuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcclxuICAgIG9wdGlvbnMgPSB1bmRlZmluZWQ7XHJcbiAgfVxyXG4gIHJldHVybiB0aGlzLl9jb25uLnJlcXVlc3QodGhpcy5fY3JlYXRlUmVxdWVzdFBhcmFtcygnREVMRVRFJywgcGF0aCwgdW5kZWZpbmVkLCBvcHRpb25zKSkudGhlbkNhbGwoY2FsbGJhY2spO1xyXG59O1xyXG5cclxuXHJcbi8qLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0qL1xyXG4vKlxyXG4gKiBSZWdpc3RlciBob29rIGluIGNvbm5lY3Rpb24gaW5zdGFudGlhdGlvbiBmb3IgZHluYW1pY2FsbHkgYWRkaW5nIHRoaXMgQVBJIG1vZHVsZSBmZWF0dXJlc1xyXG4gKi9cclxuanNmb3JjZS5vbignY29ubmVjdGlvbjpuZXcnLCBmdW5jdGlvbihjb25uKSB7XHJcbiAgY29ubi5hcGV4ID0gbmV3IEFwZXgoY29ubik7XHJcbn0pO1xyXG5cclxuXHJcbm1vZHVsZS5leHBvcnRzID0gQXBleDtcclxuIl19

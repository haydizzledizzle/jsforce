(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g=(g.jsforce||(g.jsforce = {}));g=(g.modules||(g.modules = {}));g=(g.api||(g.api = {}));g.Bulk = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
(function (process){
/*global process*/
/**
 * @file Manages Salesforce Bulk API related operations
 * @author Shinichi Tomita <shinichi.tomita@gmail.com>
 */

'use strict';

var inherits     = window.jsforce.require('inherits'),
    stream       = window.jsforce.require('readable-stream'),
    Duplex       = stream.Duplex,
    events       = window.jsforce.require('events'),
    _            = window.jsforce.require('lodash/core'),
    joinStreams  = window.jsforce.require('multistream'),
    jsforce      = window.jsforce.require('./core'),
    RecordStream = window.jsforce.require('./record-stream'),
    Promise      = window.jsforce.require('./promise'),
    HttpApi      = window.jsforce.require('./http-api');

/*--------------------------------------------*/

/**
 * Class for Bulk API Job
 *
 * @protected
 * @class Bulk~Job
 * @extends events.EventEmitter
 *
 * @param {Bulk} bulk - Bulk API object
 * @param {String} [type] - SObject type
 * @param {String} [operation] - Bulk load operation ('insert', 'update', 'upsert', 'delete', or 'hardDelete')
 * @param {Object} [options] - Options for bulk loading operation
 * @param {String} [options.extIdField] - External ID field name (used when upsert operation).
 * @param {String} [options.concurrencyMode] - 'Serial' or 'Parallel'. Defaults to Parallel.
 * @param {String} [jobId] - Job ID (if already available)
 */
var Job = function(bulk, type, operation, options, jobId) {
  this._bulk = bulk;
  this.type = type;
  this.operation = operation;
  this.options = options || {};
  this.id = jobId;
  this.state = this.id ? 'Open' : 'Unknown';
  this._batches = {};
};

inherits(Job, events.EventEmitter);

/**
 * @typedef {Object} Bulk~JobInfo
 * @prop {String} id - Job ID
 * @prop {String} object - Object type name
 * @prop {String} operation - Operation type of the job
 * @prop {String} state - Job status
 */

/**
 * Return latest jobInfo from cache
 *
 * @method Bulk~Job#info
 * @param {Callback.<Bulk~JobInfo>} [callback] - Callback function
 * @returns {Promise.<Bulk~JobInfo>}
 */
Job.prototype.info = function(callback) {
  var self = this;
  // if cache is not available, check the latest
  if (!this._jobInfo) {
    this._jobInfo = this.check();
  }
  return this._jobInfo.thenCall(callback);
};

/**
 * Open new job and get jobinfo
 *
 * @method Bulk~Job#open
 * @param {Callback.<Bulk~JobInfo>} [callback] - Callback function
 * @returns {Promise.<Bulk~JobInfo>}
 */
Job.prototype.open = function(callback) {
  var self = this;
  var bulk = this._bulk;
  var logger = bulk._logger;

  // if not requested opening job
  if (!this._jobInfo) {
    var operation = this.operation.toLowerCase();
    if (operation === 'harddelete') { operation = 'hardDelete'; }
    var body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<jobInfo  xmlns="http://www.force.com/2009/06/asyncapi/dataload">',
        '<operation>' + operation + '</operation>',
        '<object>' + this.type + '</object>',
        (this.options.extIdField ?
         '<externalIdFieldName>'+this.options.extIdField+'</externalIdFieldName>' :
         ''),
        (this.options.concurrencyMode ?
         '<concurrencyMode>'+this.options.concurrencyMode+'</concurrencyMode>' :
         ''),
        (this.options.assignmentRuleId ?
          '<assignmentRuleId>' + this.options.assignmentRuleId + '</assignmentRuleId>' :
          ''),
        '<contentType>CSV</contentType>',
      '</jobInfo>'
    ].join('');

    this._jobInfo = bulk._request({
      method : 'POST',
      path : "/job",
      body : body,
      headers : {
        "Content-Type" : "application/xml; charset=utf-8",
        "Sforce-Enable-PKChunking": (this.options.pkChunking || this.options.chunkSize) ? 
          (this.options.chunkSize ? "chunkSize=" + this.options.chunkSize : "true"): "false"
      },
      responseType: "application/xml"
    }).then(function(res) {
      self.emit("open", res.jobInfo);
      self.id = res.jobInfo.id;
      self.state = res.jobInfo.state;
      return res.jobInfo;
    }, function(err) {
      self.emit("error", err);
      throw err;
    });
  }
  return this._jobInfo.thenCall(callback);
};

/**
 * Create a new batch instance in the job
 *
 * @method Bulk~Job#createBatch
 * @returns {Bulk~Batch}
 */
Job.prototype.createBatch = function() {
  var batch = new Batch(this);
  var self = this;
  batch.on('queue', function() {
    self._batches[batch.id] = batch;
  });
  return batch;
};

/**
 * Get a batch instance specified by given batch ID
 *
 * @method Bulk~Job#batch
 * @param {String} batchId - Batch ID
 * @returns {Bulk~Batch}
 */
Job.prototype.batch = function(batchId) {
  var batch = this._batches[batchId];
  if (!batch) {
    batch = new Batch(this, batchId);
    this._batches[batchId] = batch;
  }
  return batch;
};

/**
 * Check the latest job status from server
 *
 * @method Bulk~Job#check
 * @param {Callback.<Bulk~JobInfo>} [callback] - Callback function
 * @returns {Promise.<Bulk~JobInfo>}
 */
Job.prototype.check = function(callback) {
  var self = this;
  var bulk = this._bulk;
  var logger = bulk._logger;

  this._jobInfo = this._waitAssign().then(function() {
    return bulk._request({
      method : 'GET',
      path : "/job/" + self.id,
      responseType: "application/xml"
    });
  }).then(function(res) {
    logger.debug(res.jobInfo);
    self.id = res.jobInfo.id;
    self.type = res.jobInfo.object;
    self.operation = res.jobInfo.operation;
    self.state = res.jobInfo.state;
    return res.jobInfo;
  });
  return this._jobInfo.thenCall(callback);
};

/**
 * Wait till the job is assigned to server
 *
 * @method Bulk~Job#info
 * @param {Callback.<Bulk~JobInfo>} [callback] - Callback function
 * @returns {Promise.<Bulk~JobInfo>}
 */
Job.prototype._waitAssign = function(callback) {
  return (this.id ? Promise.resolve({ id: this.id }) : this.open()).thenCall(callback);
};


/**
 * List all registered batch info in job
 *
 * @method Bulk~Job#list
 * @param {Callback.<Array.<Bulk~BatchInfo>>} [callback] - Callback function
 * @returns {Promise.<Array.<Bulk~BatchInfo>>}
 */
Job.prototype.list = function(callback) {
  var self = this;
  var bulk = this._bulk;
  var logger = bulk._logger;

  return this._waitAssign().then(function() {
    return bulk._request({
      method : 'GET',
      path : "/job/" + self.id + "/batch",
      responseType: "application/xml"
    });
  }).then(function(res) {
    logger.debug(res.batchInfoList.batchInfo);
    var batchInfoList = res.batchInfoList;
    batchInfoList = _.isArray(batchInfoList.batchInfo) ? batchInfoList.batchInfo : [ batchInfoList.batchInfo ];
    return batchInfoList;
  }).thenCall(callback);

};

/**
 * Close opened job
 *
 * @method Bulk~Job#close
 * @param {Callback.<Bulk~JobInfo>} [callback] - Callback function
 * @returns {Promise.<Bulk~JobInfo>}
 */
Job.prototype.close = function() {
  var self = this;
  return this._changeState("Closed").then(function(jobInfo) {
    self.id = null;
    self.emit("close", jobInfo);
    return jobInfo;
  }, function(err) {
    self.emit("error", err);
    throw err;
  });
};

/**
 * Set the status to abort
 *
 * @method Bulk~Job#abort
 * @param {Callback.<Bulk~JobInfo>} [callback] - Callback function
 * @returns {Promise.<Bulk~JobInfo>}
 */
Job.prototype.abort = function() {
  var self = this;
  return this._changeState("Aborted").then(function(jobInfo) {
    self.id = null;
    self.emit("abort", jobInfo);
    return jobInfo;
  }, function(err) {
    self.emit("error", err);
    throw err;
  });
};

/**
 * @private
 */
Job.prototype._changeState = function(state, callback) {
  var self = this;
  var bulk = this._bulk;
  var logger = bulk._logger;

  this._jobInfo = this._waitAssign().then(function() {
    var body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<jobInfo xmlns="http://www.force.com/2009/06/asyncapi/dataload">',
        '<state>' + state + '</state>',
      '</jobInfo>'
    ].join('');
    return bulk._request({
      method : 'POST',
      path : "/job/" + self.id,
      body : body,
      headers : {
        "Content-Type" : "application/xml; charset=utf-8"
      },
      responseType: "application/xml"
    });
  }).then(function(res) {
    logger.debug(res.jobInfo);
    self.state = res.jobInfo.state;
    return res.jobInfo;
  });
  return this._jobInfo.thenCall(callback);

};


/*--------------------------------------------*/

/**
 * Batch (extends RecordStream)
 *
 * @protected
 * @class Bulk~Batch
 * @extends {stream.Writable}
 * @implements {Promise.<Array.<RecordResult>>}
 * @param {Bulk~Job} job - Bulk job object
 * @param {String} [batchId] - Batch ID (if already available)
 */
var Batch = function(job, batchId) {
  Batch.super_.call(this, { objectMode: true });
  this.job = job;
  this.id = batchId;
  this._bulk = job._bulk;
  this._deferred = Promise.defer();
  this._setupDataStreams();
};

inherits(Batch, stream.Writable);


/**
 * @private
 */
Batch.prototype._setupDataStreams = function() {
  var batch = this;
  var converterOptions = { nullValue : '#N/A' };
  this._uploadStream = new RecordStream.Serializable();
  this._uploadDataStream = this._uploadStream.stream('csv', converterOptions);
  this._downloadStream = new RecordStream.Parsable();
  this._downloadDataStream = this._downloadStream.stream('csv', converterOptions);

  this.on('finish', function() {
    batch._uploadStream.end();
  });
  this._uploadDataStream.once('readable', function() {
    batch.job.open().then(function() {
      // pipe upload data to batch API request stream
      batch._uploadDataStream.pipe(batch._createRequestStream());
    });
  });

  // duplex data stream, opened access to API programmers by Batch#stream()
  var dataStream = this._dataStream = new Duplex();
  dataStream._write = function(data, enc, cb) {
    batch._uploadDataStream.write(data, enc, cb);
  };
  dataStream.on('finish', function() {
    batch._uploadDataStream.end();
  });

  this._downloadDataStream.on('readable', function() {
    dataStream.read(0);
  });
  this._downloadDataStream.on('end', function() {
    dataStream.push(null);
  });
  dataStream._read = function(size) {
    var chunk;
    while ((chunk = batch._downloadDataStream.read()) !== null) {
      dataStream.push(chunk);
    }
  };
};

/**
 * Connect batch API and create stream instance of request/response
 *
 * @private
 * @returns {stream.Duplex}
 */
Batch.prototype._createRequestStream = function() {
  var batch = this;
  var bulk = batch._bulk;
  var logger = bulk._logger;

  return bulk._request({
    method : 'POST',
    path : "/job/" + batch.job.id + "/batch",
    headers: {
      "Content-Type": "text/csv"
    },
    responseType: "application/xml"
  }, function(err, res) {
    if (err) {
      batch.emit('error', err);
    } else {
      logger.debug(res.batchInfo);
      batch.id = res.batchInfo.id;
      batch.emit('queue', res.batchInfo);
    }
  }).stream();
};

/**
 * Implementation of Writable
 *
 * @override
 * @private
 */
Batch.prototype._write = function(record, enc, cb) {
  record = _.clone(record);
  if (this.job.operation === "insert") {
    delete record.Id;
  } else if (this.job.operation === "delete") {
    record = { Id: record.Id };
  }
  delete record.type;
  delete record.attributes;
  this._uploadStream.write(record, enc, cb);
};

/**
 * Returns duplex stream which accepts CSV data input and batch result output
 *
 * @returns {stream.Duplex}
 */
Batch.prototype.stream = function() {
  return this._dataStream;
};

/**
 * Execute batch operation
 *
 * @method Bulk~Batch#execute
 * @param {Array.<Record>|stream.Stream|String} [input] - Input source for batch operation. Accepts array of records, CSV string, and CSV data input stream in insert/update/upsert/delete/hardDelete operation, SOQL string in query operation.
 * @param {Callback.<Array.<RecordResult>|Array.<BatchResultInfo>>} [callback] - Callback function
 * @returns {Bulk~Batch}
 */
Batch.prototype.run =
Batch.prototype.exec =
Batch.prototype.execute = function(input, callback) {
  var self = this;

  if (typeof input === 'function') { // if input argument is omitted
    callback = input;
    input = null;
  }

  // if batch is already executed
  if (this._result) {
    throw new Error("Batch already executed.");
  }

  var rdeferred = Promise.defer();
  this._result = rdeferred.promise;
  this._result.then(function(res) {
    self._deferred.resolve(res);
  }, function(err) {
    self._deferred.reject(err);
  });
  this.once('response', function(res) {
    rdeferred.resolve(res);
  });
  this.once('error', function(err) {
    rdeferred.reject(err);
  });

  if (_.isObject(input) && _.isFunction(input.pipe)) { // if input has stream.Readable interface
    input.pipe(this._dataStream);
  } else {
    var data;
    if (_.isArray(input)) {
      _.forEach(input, function(record) {
        Object.keys(record).forEach(function(key) {
          if (typeof record[key] === 'boolean') {
            record[key] = String(record[key])
          }
        })
        self.write(record);
      });
      self.end();
    } else if (_.isString(input)){
      data = input;
      this._dataStream.write(data, 'utf8');
      this._dataStream.end();
    }
  }

  // return Batch instance for chaining
  return this.thenCall(callback);
};

/**
 * Promise/A+ interface
 * http://promises-aplus.github.io/promises-spec/
 *
 * Delegate to deferred promise, return promise instance for batch result
 *
 * @method Bulk~Batch#then
 */
Batch.prototype.then = function(onResolved, onReject, onProgress) {
  return this._deferred.promise.then(onResolved, onReject, onProgress);
};

/**
 * Promise/A+ extension
 * Call "then" using given node-style callback function
 *
 * @method Bulk~Batch#thenCall
 */
Batch.prototype.thenCall = function(callback) {
  if (_.isFunction(callback)) {
    this.then(function(res) {
      process.nextTick(function() {
        callback(null, res);
      });
    }, function(err) {
      process.nextTick(function() {
        callback(err);
      });
    });
  }
  return this;
};

/**
 * @typedef {Object} Bulk~BatchInfo
 * @prop {String} id - Batch ID
 * @prop {String} jobId - Job ID
 * @prop {String} state - Batch state
 * @prop {String} stateMessage - Batch state message
 */

/**
 * Check the latest batch status in server
 *
 * @method Bulk~Batch#check
 * @param {Callback.<Bulk~BatchInfo>} [callback] - Callback function
 * @returns {Promise.<Bulk~BatchInfo>}
 */
Batch.prototype.check = function(callback) {
  var self = this;
  var bulk = this._bulk;
  var logger = bulk._logger;
  var jobId = this.job.id;
  var batchId = this.id;

  if (!jobId || !batchId) {
    throw new Error("Batch not started.");
  }
  return bulk._request({
    method : 'GET',
    path : "/job/" + jobId + "/batch/" + batchId,
    responseType: "application/xml"
  }).then(function(res) {
    logger.debug(res.batchInfo);
    return res.batchInfo;
  }).thenCall(callback);
};


/**
 * Polling the batch result and retrieve
 *
 * @method Bulk~Batch#poll
 * @param {Number} interval - Polling interval in milliseconds
 * @param {Number} timeout - Polling timeout in milliseconds
 */
Batch.prototype.poll = function(interval, timeout) {
  var self = this;
  var jobId = this.job.id;
  var batchId = this.id;

  if (!jobId || !batchId) {
    throw new Error("Batch not started.");
  }
  var startTime = new Date().getTime();
  var poll = function() {
    var now = new Date().getTime();
    if (startTime + timeout < now) {
      var err = new Error("Polling time out. Job Id = " + jobId + " , batch Id = " + batchId);
      err.name = 'PollingTimeout';
      err.jobId = jobId;
      err.batchId = batchId;
      self.emit('error', err);
      return;
    }
    self.check(function(err, res) {
      if (err) {
        self.emit('error', err);
      } else {
        if (res.state === "Failed") {
          if (parseInt(res.numberRecordsProcessed, 10) > 0) {
            self.retrieve();
          } else {
            self.emit('error', new Error(res.stateMessage));
          }
        } else if (res.state === "Completed") {
          self.retrieve();
        } else {
          self.emit('progress', res);
          if (self.pollHandle) {
            self.pollHandle = setTimeout(poll, interval);
          }
        }
      }
    });
  };
  this.pollHandle = setTimeout(poll, interval);
};

/**
 * Stops polling the current batch for progress. Call this to stop `poll` and break the polling loop.
 */
Batch.prototype.pollStop = function() {
  if (!this.pollHandle) {
    throw new Error("Polling not started.");
  }
  clearTimeout(this.pollHandle);
  this.pollHandle = undefined;
}

/**
 * @typedef {Object} Bulk~BatchResultInfo
 * @prop {String} id - Batch result ID
 * @prop {String} batchId - Batch ID which includes this batch result.
 * @prop {String} jobId - Job ID which includes this batch result.
 */

/**
 * Retrieve batch result
 *
 * @method Bulk~Batch#retrieve
 * @param {Callback.<Array.<RecordResult>|Array.<Bulk~BatchResultInfo>>} [callback] - Callback function
 * @returns {Promise.<Array.<RecordResult>|Array.<Bulk~BatchResultInfo>>}
 */
Batch.prototype.retrieve = function(callback) {
  var self = this;
  var bulk = this._bulk;
  var jobId = this.job.id;
  var job = this.job;
  var batchId = this.id;

  if (!jobId || !batchId) {
    throw new Error("Batch not started.");
  }

  return job.info().then(function(jobInfo) {
    return bulk._request({
      method : 'GET',
      path : "/job/" + jobId + "/batch/" + batchId + "/result"
    });
  }).then(function(res) {
    var results;
    if (job.operation === 'query') {
      var conn = bulk._conn;
      var resultIds = res['result-list'].result;
      results = res['result-list'].result;
      results = _.map(_.isArray(results) ? results : [ results ], function(id) {
        return {
          id: id,
          batchId: batchId,
          jobId: jobId
        };
      });
    } else {
      results = _.map(res, function(ret) {
        return {
          id: ret.Id || null,
          success: ret.Success === "true",
          errors: ret.Error ? [ ret.Error ] : []
        };
      });
    }
    self.emit('response', results);
    return results;
  }).fail(function(err) {
    self.emit('error', err);
    throw err;
  }).thenCall(callback);
};

/**
 * Fetch query result as a record stream
 * @param {String} resultId - Result id
 * @returns {RecordStream} - Record stream, convertible to CSV data stream
 */
Batch.prototype.result = function(resultId) {
  var jobId = this.job.id;
  var batchId = this.id;
  if (!jobId || !batchId) {
    throw new Error("Batch not started.");
  }
  var resultStream = new RecordStream.Parsable();
  var resultDataStream = resultStream.stream('csv');
  var reqStream = this._bulk._request({
    method : 'GET',
    path : "/job/" + jobId + "/batch/" + batchId + "/result/" + resultId,
    responseType: "application/octet-stream"
  }).stream().pipe(resultDataStream);
  return resultStream;
};

/*--------------------------------------------*/
/**
 * @private
 */
var BulkApi = function() {
  BulkApi.super_.apply(this, arguments);
};

inherits(BulkApi, HttpApi);

BulkApi.prototype.beforeSend = function(request) {
  request.headers = request.headers || {};
  request.headers["X-SFDC-SESSION"] = this._conn.accessToken;
};

BulkApi.prototype.isSessionExpired = function(response) {
  return response.statusCode === 400 &&
    /<exceptionCode>InvalidSessionId<\/exceptionCode>/.test(response.body);
};

BulkApi.prototype.hasErrorInResponseBody = function(body) {
  return !!body.error;
};

BulkApi.prototype.parseError = function(body) {
  return {
    errorCode: body.error.exceptionCode,
    message: body.error.exceptionMessage
  };
};

/*--------------------------------------------*/

/**
 * Class for Bulk API
 *
 * @class
 * @param {Connection} conn - Connection object
 */
var Bulk = function(conn) {
  this._conn = conn;
  this._logger = conn._logger;
};

/**
 * Polling interval in milliseconds
 * @type {Number}
 */
Bulk.prototype.pollInterval = 1000;

/**
 * Polling timeout in milliseconds
 * @type {Number}
 */
Bulk.prototype.pollTimeout = 10000;

/** @private **/
Bulk.prototype._request = function(request, callback) {
  var conn = this._conn;
  request = _.clone(request);
  var baseUrl = [ conn.instanceUrl, "services/async", conn.version ].join('/');
  request.url = baseUrl + request.path;
  var options = { responseType: request.responseType };
  delete request.path;
  delete request.responseType;
  return new BulkApi(this._conn, options).request(request).thenCall(callback);
};

/**
 * Create and start bulkload job and batch
 *
 * @param {String} type - SObject type
 * @param {String} operation - Bulk load operation ('insert', 'update', 'upsert', 'delete', or 'hardDelete')
 * @param {Object} [options] - Options for bulk loading operation
 * @param {String} [options.extIdField] - External ID field name (used when upsert operation).
 * @param {String} [options.concurrencyMode] - 'Serial' or 'Parallel'. Defaults to Parallel.
 * @param {Boolean} [options.pkChunking] - Enables PK Chunking for Bulk API Query. Defaults to false. Use chunkSize to change the default chunk size.
 * @param {Number} [options.chunkSize] - Chunk size for `pkChunking`; when set forces PK Chunking to to true.
 * @param {Array.<Record>|stream.Stream|String} [input] - Input source for bulkload. Accepts array of records, CSV string, and CSV data input stream in insert/update/upsert/delete/hardDelete operation, SOQL string in query operation.
 * @param {Callback.<Array.<RecordResult>|Array.<Bulk~BatchResultInfo>>} [callback] - Callback function
 * @returns {Bulk~Batch}
 */
Bulk.prototype.load = function(type, operation, options, input, callback) {
  var self = this;
  if (!type || !operation) {
    throw new Error("Insufficient arguments. At least, 'type' and 'operation' are required.");
  }
  if (!_.isObject(options) || options.constructor !== Object) { // when options is not plain hash object, it is omitted
    callback = input;
    input = options;
    options = null;
  }
  var job = this.createJob(type, operation, options);
  var isChunking = options.pkChunking || options.chunkSize;
  job.once('error', function (error) {
    if (batch) {
      batch.emit('error', error); // pass job error to batch
    }
  });
  var batch = job.createBatch();
  var cleanup = function() {
    batch = null;
    job.close();
  };
  var cleanupOnError = function(err) {
    if (err.name !== 'PollingTimeout') {
      cleanup();
    }
  };
  if (isChunking) {
    var retrieveAll = function(batches) {
      var results = Promise.all(batches.map(function(info) {
        return job.batch(info.id).retrieve();
      }));
      results.then(function(res) { 
        batch.emit('response', _.flatten(res));
      }, function(err) { 
        self.emit('error', err);
      });
      return results;
    };
    var pollBatches = function() {
      job.list(function(err, batches) { 
        if (!err) {
          batches = batches.filter(function(info) { return info.id != batch.id; });
          var allCompleted = batches.every(function(info) { return info.state == 'Completed'; });     
          if (allCompleted) {
            retrieveAll(batches);
          } else {
            var failedBatch = batches.find(function(info) { return info.state == 'Failed'; });
            if (failedBatch) {
              self.emit('error', new Error(failedBatch.stateMessage));
            } else {
              setTimeout(pollBatches, self.pollInterval);
            }
          }
        } else {
          self.emit('error', error);
        }
      });
    };
    var handleProgress = function(progress) { 
      if (progress.state == "NotProcessed") {
        batch.pollStop();
        pollBatches();
      }
    };
    batch.on('progress', handleProgress);
  }
  batch.on('response', cleanup);
  batch.on('error', cleanupOnError);
  batch.on('queue', function() { batch.poll(self.pollInterval, self.pollTimeout); });
  return batch.execute(input, callback);
};

/**
 * Execute bulk query and get record stream
 *
 * @param {String} soql - SOQL to execute in bulk job
 * @returns {RecordStream.Parsable} - Record stream, convertible to CSV data stream
 */
Bulk.prototype.query = function(soql, options) {
  var m = soql.replace(/\([\s\S]+\)/g, '').match(/FROM\s+(\w+)/i);
  if (!m) {
    throw new Error("No sobject type found in query, maybe caused by invalid SOQL.");
  }
  var type = m[1];
  var self = this;
  var recordStream = new RecordStream.Parsable();
  var dataStream = recordStream.stream('csv');
  this.load(type, "query", options, soql).then(function(results) {
    var streams = results.map(function(result) {
      var job = self.job(result.jobId);
      return function() { 
        return job
          .batch(result.batchId)
          .result(result.id)
          .stream();
      };
    });

    joinStreams(streams).pipe(dataStream);
  }).fail(function(err) {
    recordStream.emit('error', err);
  });
  return recordStream;
};


/**
 * Create a new job instance
 *
 * @param {String} type - SObject type
 * @param {String} operation - Bulk load operation ('insert', 'update', 'upsert', 'delete', 'hardDelete', or 'query')
 * @param {Object} [options] - Options for bulk loading operation
 * @returns {Bulk~Job}
 */
Bulk.prototype.createJob = function(type, operation, options) {
  return new Job(this, type, operation, options);
};

/**
 * Get a job instance specified by given job ID
 *
 * @param {String} jobId - Job ID
 * @returns {Bulk~Job}
 */
Bulk.prototype.job = function(jobId) {
  return new Job(this, null, null, null, jobId);
};


/*--------------------------------------------*/
/*
 * Register hook in connection instantiation for dynamically adding this API module features
 */
jsforce.on('connection:new', function(conn) {
  conn.bulk = new Bulk(conn);
});


module.exports = Bulk;

}).call(this,require('_process'))

},{"_process":2}],2:[function(require,module,exports){
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

},{}]},{},[1])(1)
});

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJsaWIvYXBpL2J1bGsuanMiLCJub2RlX21vZHVsZXMvcHJvY2Vzcy9icm93c2VyLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOztBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUN2NUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbigpe2Z1bmN0aW9uIHIoZSxuLHQpe2Z1bmN0aW9uIG8oaSxmKXtpZighbltpXSl7aWYoIWVbaV0pe3ZhciBjPVwiZnVuY3Rpb25cIj09dHlwZW9mIHJlcXVpcmUmJnJlcXVpcmU7aWYoIWYmJmMpcmV0dXJuIGMoaSwhMCk7aWYodSlyZXR1cm4gdShpLCEwKTt2YXIgYT1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK2krXCInXCIpO3Rocm93IGEuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixhfXZhciBwPW5baV09e2V4cG9ydHM6e319O2VbaV1bMF0uY2FsbChwLmV4cG9ydHMsZnVuY3Rpb24ocil7dmFyIG49ZVtpXVsxXVtyXTtyZXR1cm4gbyhufHxyKX0scCxwLmV4cG9ydHMscixlLG4sdCl9cmV0dXJuIG5baV0uZXhwb3J0c31mb3IodmFyIHU9XCJmdW5jdGlvblwiPT10eXBlb2YgcmVxdWlyZSYmcmVxdWlyZSxpPTA7aTx0Lmxlbmd0aDtpKyspbyh0W2ldKTtyZXR1cm4gb31yZXR1cm4gcn0pKCkiLCIvKmdsb2JhbCBwcm9jZXNzKi9cclxuLyoqXHJcbiAqIEBmaWxlIE1hbmFnZXMgU2FsZXNmb3JjZSBCdWxrIEFQSSByZWxhdGVkIG9wZXJhdGlvbnNcclxuICogQGF1dGhvciBTaGluaWNoaSBUb21pdGEgPHNoaW5pY2hpLnRvbWl0YUBnbWFpbC5jb20+XHJcbiAqL1xyXG5cclxuJ3VzZSBzdHJpY3QnO1xyXG5cclxudmFyIGluaGVyaXRzICAgICA9IHdpbmRvdy5qc2ZvcmNlLnJlcXVpcmUoJ2luaGVyaXRzJyksXHJcbiAgICBzdHJlYW0gICAgICAgPSB3aW5kb3cuanNmb3JjZS5yZXF1aXJlKCdyZWFkYWJsZS1zdHJlYW0nKSxcclxuICAgIER1cGxleCAgICAgICA9IHN0cmVhbS5EdXBsZXgsXHJcbiAgICBldmVudHMgICAgICAgPSB3aW5kb3cuanNmb3JjZS5yZXF1aXJlKCdldmVudHMnKSxcclxuICAgIF8gICAgICAgICAgICA9IHdpbmRvdy5qc2ZvcmNlLnJlcXVpcmUoJ2xvZGFzaC9jb3JlJyksXHJcbiAgICBqb2luU3RyZWFtcyAgPSB3aW5kb3cuanNmb3JjZS5yZXF1aXJlKCdtdWx0aXN0cmVhbScpLFxyXG4gICAganNmb3JjZSAgICAgID0gd2luZG93LmpzZm9yY2UucmVxdWlyZSgnLi9jb3JlJyksXHJcbiAgICBSZWNvcmRTdHJlYW0gPSB3aW5kb3cuanNmb3JjZS5yZXF1aXJlKCcuL3JlY29yZC1zdHJlYW0nKSxcclxuICAgIFByb21pc2UgICAgICA9IHdpbmRvdy5qc2ZvcmNlLnJlcXVpcmUoJy4vcHJvbWlzZScpLFxyXG4gICAgSHR0cEFwaSAgICAgID0gd2luZG93LmpzZm9yY2UucmVxdWlyZSgnLi9odHRwLWFwaScpO1xyXG5cclxuLyotLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSovXHJcblxyXG4vKipcclxuICogQ2xhc3MgZm9yIEJ1bGsgQVBJIEpvYlxyXG4gKlxyXG4gKiBAcHJvdGVjdGVkXHJcbiAqIEBjbGFzcyBCdWxrfkpvYlxyXG4gKiBAZXh0ZW5kcyBldmVudHMuRXZlbnRFbWl0dGVyXHJcbiAqXHJcbiAqIEBwYXJhbSB7QnVsa30gYnVsayAtIEJ1bGsgQVBJIG9iamVjdFxyXG4gKiBAcGFyYW0ge1N0cmluZ30gW3R5cGVdIC0gU09iamVjdCB0eXBlXHJcbiAqIEBwYXJhbSB7U3RyaW5nfSBbb3BlcmF0aW9uXSAtIEJ1bGsgbG9hZCBvcGVyYXRpb24gKCdpbnNlcnQnLCAndXBkYXRlJywgJ3Vwc2VydCcsICdkZWxldGUnLCBvciAnaGFyZERlbGV0ZScpXHJcbiAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBPcHRpb25zIGZvciBidWxrIGxvYWRpbmcgb3BlcmF0aW9uXHJcbiAqIEBwYXJhbSB7U3RyaW5nfSBbb3B0aW9ucy5leHRJZEZpZWxkXSAtIEV4dGVybmFsIElEIGZpZWxkIG5hbWUgKHVzZWQgd2hlbiB1cHNlcnQgb3BlcmF0aW9uKS5cclxuICogQHBhcmFtIHtTdHJpbmd9IFtvcHRpb25zLmNvbmN1cnJlbmN5TW9kZV0gLSAnU2VyaWFsJyBvciAnUGFyYWxsZWwnLiBEZWZhdWx0cyB0byBQYXJhbGxlbC5cclxuICogQHBhcmFtIHtTdHJpbmd9IFtqb2JJZF0gLSBKb2IgSUQgKGlmIGFscmVhZHkgYXZhaWxhYmxlKVxyXG4gKi9cclxudmFyIEpvYiA9IGZ1bmN0aW9uKGJ1bGssIHR5cGUsIG9wZXJhdGlvbiwgb3B0aW9ucywgam9iSWQpIHtcclxuICB0aGlzLl9idWxrID0gYnVsaztcclxuICB0aGlzLnR5cGUgPSB0eXBlO1xyXG4gIHRoaXMub3BlcmF0aW9uID0gb3BlcmF0aW9uO1xyXG4gIHRoaXMub3B0aW9ucyA9IG9wdGlvbnMgfHwge307XHJcbiAgdGhpcy5pZCA9IGpvYklkO1xyXG4gIHRoaXMuc3RhdGUgPSB0aGlzLmlkID8gJ09wZW4nIDogJ1Vua25vd24nO1xyXG4gIHRoaXMuX2JhdGNoZXMgPSB7fTtcclxufTtcclxuXHJcbmluaGVyaXRzKEpvYiwgZXZlbnRzLkV2ZW50RW1pdHRlcik7XHJcblxyXG4vKipcclxuICogQHR5cGVkZWYge09iamVjdH0gQnVsa35Kb2JJbmZvXHJcbiAqIEBwcm9wIHtTdHJpbmd9IGlkIC0gSm9iIElEXHJcbiAqIEBwcm9wIHtTdHJpbmd9IG9iamVjdCAtIE9iamVjdCB0eXBlIG5hbWVcclxuICogQHByb3Age1N0cmluZ30gb3BlcmF0aW9uIC0gT3BlcmF0aW9uIHR5cGUgb2YgdGhlIGpvYlxyXG4gKiBAcHJvcCB7U3RyaW5nfSBzdGF0ZSAtIEpvYiBzdGF0dXNcclxuICovXHJcblxyXG4vKipcclxuICogUmV0dXJuIGxhdGVzdCBqb2JJbmZvIGZyb20gY2FjaGVcclxuICpcclxuICogQG1ldGhvZCBCdWxrfkpvYiNpbmZvXHJcbiAqIEBwYXJhbSB7Q2FsbGJhY2suPEJ1bGt+Sm9iSW5mbz59IFtjYWxsYmFja10gLSBDYWxsYmFjayBmdW5jdGlvblxyXG4gKiBAcmV0dXJucyB7UHJvbWlzZS48QnVsa35Kb2JJbmZvPn1cclxuICovXHJcbkpvYi5wcm90b3R5cGUuaW5mbyA9IGZ1bmN0aW9uKGNhbGxiYWNrKSB7XHJcbiAgdmFyIHNlbGYgPSB0aGlzO1xyXG4gIC8vIGlmIGNhY2hlIGlzIG5vdCBhdmFpbGFibGUsIGNoZWNrIHRoZSBsYXRlc3RcclxuICBpZiAoIXRoaXMuX2pvYkluZm8pIHtcclxuICAgIHRoaXMuX2pvYkluZm8gPSB0aGlzLmNoZWNrKCk7XHJcbiAgfVxyXG4gIHJldHVybiB0aGlzLl9qb2JJbmZvLnRoZW5DYWxsKGNhbGxiYWNrKTtcclxufTtcclxuXHJcbi8qKlxyXG4gKiBPcGVuIG5ldyBqb2IgYW5kIGdldCBqb2JpbmZvXHJcbiAqXHJcbiAqIEBtZXRob2QgQnVsa35Kb2Ijb3BlblxyXG4gKiBAcGFyYW0ge0NhbGxiYWNrLjxCdWxrfkpvYkluZm8+fSBbY2FsbGJhY2tdIC0gQ2FsbGJhY2sgZnVuY3Rpb25cclxuICogQHJldHVybnMge1Byb21pc2UuPEJ1bGt+Sm9iSW5mbz59XHJcbiAqL1xyXG5Kb2IucHJvdG90eXBlLm9wZW4gPSBmdW5jdGlvbihjYWxsYmFjaykge1xyXG4gIHZhciBzZWxmID0gdGhpcztcclxuICB2YXIgYnVsayA9IHRoaXMuX2J1bGs7XHJcbiAgdmFyIGxvZ2dlciA9IGJ1bGsuX2xvZ2dlcjtcclxuXHJcbiAgLy8gaWYgbm90IHJlcXVlc3RlZCBvcGVuaW5nIGpvYlxyXG4gIGlmICghdGhpcy5fam9iSW5mbykge1xyXG4gICAgdmFyIG9wZXJhdGlvbiA9IHRoaXMub3BlcmF0aW9uLnRvTG93ZXJDYXNlKCk7XHJcbiAgICBpZiAob3BlcmF0aW9uID09PSAnaGFyZGRlbGV0ZScpIHsgb3BlcmF0aW9uID0gJ2hhcmREZWxldGUnOyB9XHJcbiAgICB2YXIgYm9keSA9IFtcclxuICAgICAgJzw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cIlVURi04XCI/PicsXHJcbiAgICAgICc8am9iSW5mbyAgeG1sbnM9XCJodHRwOi8vd3d3LmZvcmNlLmNvbS8yMDA5LzA2L2FzeW5jYXBpL2RhdGFsb2FkXCI+JyxcclxuICAgICAgICAnPG9wZXJhdGlvbj4nICsgb3BlcmF0aW9uICsgJzwvb3BlcmF0aW9uPicsXHJcbiAgICAgICAgJzxvYmplY3Q+JyArIHRoaXMudHlwZSArICc8L29iamVjdD4nLFxyXG4gICAgICAgICh0aGlzLm9wdGlvbnMuZXh0SWRGaWVsZCA/XHJcbiAgICAgICAgICc8ZXh0ZXJuYWxJZEZpZWxkTmFtZT4nK3RoaXMub3B0aW9ucy5leHRJZEZpZWxkKyc8L2V4dGVybmFsSWRGaWVsZE5hbWU+JyA6XHJcbiAgICAgICAgICcnKSxcclxuICAgICAgICAodGhpcy5vcHRpb25zLmNvbmN1cnJlbmN5TW9kZSA/XHJcbiAgICAgICAgICc8Y29uY3VycmVuY3lNb2RlPicrdGhpcy5vcHRpb25zLmNvbmN1cnJlbmN5TW9kZSsnPC9jb25jdXJyZW5jeU1vZGU+JyA6XHJcbiAgICAgICAgICcnKSxcclxuICAgICAgICAodGhpcy5vcHRpb25zLmFzc2lnbm1lbnRSdWxlSWQgP1xyXG4gICAgICAgICAgJzxhc3NpZ25tZW50UnVsZUlkPicgKyB0aGlzLm9wdGlvbnMuYXNzaWdubWVudFJ1bGVJZCArICc8L2Fzc2lnbm1lbnRSdWxlSWQ+JyA6XHJcbiAgICAgICAgICAnJyksXHJcbiAgICAgICAgJzxjb250ZW50VHlwZT5DU1Y8L2NvbnRlbnRUeXBlPicsXHJcbiAgICAgICc8L2pvYkluZm8+J1xyXG4gICAgXS5qb2luKCcnKTtcclxuXHJcbiAgICB0aGlzLl9qb2JJbmZvID0gYnVsay5fcmVxdWVzdCh7XHJcbiAgICAgIG1ldGhvZCA6ICdQT1NUJyxcclxuICAgICAgcGF0aCA6IFwiL2pvYlwiLFxyXG4gICAgICBib2R5IDogYm9keSxcclxuICAgICAgaGVhZGVycyA6IHtcclxuICAgICAgICBcIkNvbnRlbnQtVHlwZVwiIDogXCJhcHBsaWNhdGlvbi94bWw7IGNoYXJzZXQ9dXRmLThcIixcclxuICAgICAgICBcIlNmb3JjZS1FbmFibGUtUEtDaHVua2luZ1wiOiAodGhpcy5vcHRpb25zLnBrQ2h1bmtpbmcgfHwgdGhpcy5vcHRpb25zLmNodW5rU2l6ZSkgPyBcclxuICAgICAgICAgICh0aGlzLm9wdGlvbnMuY2h1bmtTaXplID8gXCJjaHVua1NpemU9XCIgKyB0aGlzLm9wdGlvbnMuY2h1bmtTaXplIDogXCJ0cnVlXCIpOiBcImZhbHNlXCJcclxuICAgICAgfSxcclxuICAgICAgcmVzcG9uc2VUeXBlOiBcImFwcGxpY2F0aW9uL3htbFwiXHJcbiAgICB9KS50aGVuKGZ1bmN0aW9uKHJlcykge1xyXG4gICAgICBzZWxmLmVtaXQoXCJvcGVuXCIsIHJlcy5qb2JJbmZvKTtcclxuICAgICAgc2VsZi5pZCA9IHJlcy5qb2JJbmZvLmlkO1xyXG4gICAgICBzZWxmLnN0YXRlID0gcmVzLmpvYkluZm8uc3RhdGU7XHJcbiAgICAgIHJldHVybiByZXMuam9iSW5mbztcclxuICAgIH0sIGZ1bmN0aW9uKGVycikge1xyXG4gICAgICBzZWxmLmVtaXQoXCJlcnJvclwiLCBlcnIpO1xyXG4gICAgICB0aHJvdyBlcnI7XHJcbiAgICB9KTtcclxuICB9XHJcbiAgcmV0dXJuIHRoaXMuX2pvYkluZm8udGhlbkNhbGwoY2FsbGJhY2spO1xyXG59O1xyXG5cclxuLyoqXHJcbiAqIENyZWF0ZSBhIG5ldyBiYXRjaCBpbnN0YW5jZSBpbiB0aGUgam9iXHJcbiAqXHJcbiAqIEBtZXRob2QgQnVsa35Kb2IjY3JlYXRlQmF0Y2hcclxuICogQHJldHVybnMge0J1bGt+QmF0Y2h9XHJcbiAqL1xyXG5Kb2IucHJvdG90eXBlLmNyZWF0ZUJhdGNoID0gZnVuY3Rpb24oKSB7XHJcbiAgdmFyIGJhdGNoID0gbmV3IEJhdGNoKHRoaXMpO1xyXG4gIHZhciBzZWxmID0gdGhpcztcclxuICBiYXRjaC5vbigncXVldWUnLCBmdW5jdGlvbigpIHtcclxuICAgIHNlbGYuX2JhdGNoZXNbYmF0Y2guaWRdID0gYmF0Y2g7XHJcbiAgfSk7XHJcbiAgcmV0dXJuIGJhdGNoO1xyXG59O1xyXG5cclxuLyoqXHJcbiAqIEdldCBhIGJhdGNoIGluc3RhbmNlIHNwZWNpZmllZCBieSBnaXZlbiBiYXRjaCBJRFxyXG4gKlxyXG4gKiBAbWV0aG9kIEJ1bGt+Sm9iI2JhdGNoXHJcbiAqIEBwYXJhbSB7U3RyaW5nfSBiYXRjaElkIC0gQmF0Y2ggSURcclxuICogQHJldHVybnMge0J1bGt+QmF0Y2h9XHJcbiAqL1xyXG5Kb2IucHJvdG90eXBlLmJhdGNoID0gZnVuY3Rpb24oYmF0Y2hJZCkge1xyXG4gIHZhciBiYXRjaCA9IHRoaXMuX2JhdGNoZXNbYmF0Y2hJZF07XHJcbiAgaWYgKCFiYXRjaCkge1xyXG4gICAgYmF0Y2ggPSBuZXcgQmF0Y2godGhpcywgYmF0Y2hJZCk7XHJcbiAgICB0aGlzLl9iYXRjaGVzW2JhdGNoSWRdID0gYmF0Y2g7XHJcbiAgfVxyXG4gIHJldHVybiBiYXRjaDtcclxufTtcclxuXHJcbi8qKlxyXG4gKiBDaGVjayB0aGUgbGF0ZXN0IGpvYiBzdGF0dXMgZnJvbSBzZXJ2ZXJcclxuICpcclxuICogQG1ldGhvZCBCdWxrfkpvYiNjaGVja1xyXG4gKiBAcGFyYW0ge0NhbGxiYWNrLjxCdWxrfkpvYkluZm8+fSBbY2FsbGJhY2tdIC0gQ2FsbGJhY2sgZnVuY3Rpb25cclxuICogQHJldHVybnMge1Byb21pc2UuPEJ1bGt+Sm9iSW5mbz59XHJcbiAqL1xyXG5Kb2IucHJvdG90eXBlLmNoZWNrID0gZnVuY3Rpb24oY2FsbGJhY2spIHtcclxuICB2YXIgc2VsZiA9IHRoaXM7XHJcbiAgdmFyIGJ1bGsgPSB0aGlzLl9idWxrO1xyXG4gIHZhciBsb2dnZXIgPSBidWxrLl9sb2dnZXI7XHJcblxyXG4gIHRoaXMuX2pvYkluZm8gPSB0aGlzLl93YWl0QXNzaWduKCkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiBidWxrLl9yZXF1ZXN0KHtcclxuICAgICAgbWV0aG9kIDogJ0dFVCcsXHJcbiAgICAgIHBhdGggOiBcIi9qb2IvXCIgKyBzZWxmLmlkLFxyXG4gICAgICByZXNwb25zZVR5cGU6IFwiYXBwbGljYXRpb24veG1sXCJcclxuICAgIH0pO1xyXG4gIH0pLnRoZW4oZnVuY3Rpb24ocmVzKSB7XHJcbiAgICBsb2dnZXIuZGVidWcocmVzLmpvYkluZm8pO1xyXG4gICAgc2VsZi5pZCA9IHJlcy5qb2JJbmZvLmlkO1xyXG4gICAgc2VsZi50eXBlID0gcmVzLmpvYkluZm8ub2JqZWN0O1xyXG4gICAgc2VsZi5vcGVyYXRpb24gPSByZXMuam9iSW5mby5vcGVyYXRpb247XHJcbiAgICBzZWxmLnN0YXRlID0gcmVzLmpvYkluZm8uc3RhdGU7XHJcbiAgICByZXR1cm4gcmVzLmpvYkluZm87XHJcbiAgfSk7XHJcbiAgcmV0dXJuIHRoaXMuX2pvYkluZm8udGhlbkNhbGwoY2FsbGJhY2spO1xyXG59O1xyXG5cclxuLyoqXHJcbiAqIFdhaXQgdGlsbCB0aGUgam9iIGlzIGFzc2lnbmVkIHRvIHNlcnZlclxyXG4gKlxyXG4gKiBAbWV0aG9kIEJ1bGt+Sm9iI2luZm9cclxuICogQHBhcmFtIHtDYWxsYmFjay48QnVsa35Kb2JJbmZvPn0gW2NhbGxiYWNrXSAtIENhbGxiYWNrIGZ1bmN0aW9uXHJcbiAqIEByZXR1cm5zIHtQcm9taXNlLjxCdWxrfkpvYkluZm8+fVxyXG4gKi9cclxuSm9iLnByb3RvdHlwZS5fd2FpdEFzc2lnbiA9IGZ1bmN0aW9uKGNhbGxiYWNrKSB7XHJcbiAgcmV0dXJuICh0aGlzLmlkID8gUHJvbWlzZS5yZXNvbHZlKHsgaWQ6IHRoaXMuaWQgfSkgOiB0aGlzLm9wZW4oKSkudGhlbkNhbGwoY2FsbGJhY2spO1xyXG59O1xyXG5cclxuXHJcbi8qKlxyXG4gKiBMaXN0IGFsbCByZWdpc3RlcmVkIGJhdGNoIGluZm8gaW4gam9iXHJcbiAqXHJcbiAqIEBtZXRob2QgQnVsa35Kb2IjbGlzdFxyXG4gKiBAcGFyYW0ge0NhbGxiYWNrLjxBcnJheS48QnVsa35CYXRjaEluZm8+Pn0gW2NhbGxiYWNrXSAtIENhbGxiYWNrIGZ1bmN0aW9uXHJcbiAqIEByZXR1cm5zIHtQcm9taXNlLjxBcnJheS48QnVsa35CYXRjaEluZm8+Pn1cclxuICovXHJcbkpvYi5wcm90b3R5cGUubGlzdCA9IGZ1bmN0aW9uKGNhbGxiYWNrKSB7XHJcbiAgdmFyIHNlbGYgPSB0aGlzO1xyXG4gIHZhciBidWxrID0gdGhpcy5fYnVsaztcclxuICB2YXIgbG9nZ2VyID0gYnVsay5fbG9nZ2VyO1xyXG5cclxuICByZXR1cm4gdGhpcy5fd2FpdEFzc2lnbigpLnRoZW4oZnVuY3Rpb24oKSB7XHJcbiAgICByZXR1cm4gYnVsay5fcmVxdWVzdCh7XHJcbiAgICAgIG1ldGhvZCA6ICdHRVQnLFxyXG4gICAgICBwYXRoIDogXCIvam9iL1wiICsgc2VsZi5pZCArIFwiL2JhdGNoXCIsXHJcbiAgICAgIHJlc3BvbnNlVHlwZTogXCJhcHBsaWNhdGlvbi94bWxcIlxyXG4gICAgfSk7XHJcbiAgfSkudGhlbihmdW5jdGlvbihyZXMpIHtcclxuICAgIGxvZ2dlci5kZWJ1ZyhyZXMuYmF0Y2hJbmZvTGlzdC5iYXRjaEluZm8pO1xyXG4gICAgdmFyIGJhdGNoSW5mb0xpc3QgPSByZXMuYmF0Y2hJbmZvTGlzdDtcclxuICAgIGJhdGNoSW5mb0xpc3QgPSBfLmlzQXJyYXkoYmF0Y2hJbmZvTGlzdC5iYXRjaEluZm8pID8gYmF0Y2hJbmZvTGlzdC5iYXRjaEluZm8gOiBbIGJhdGNoSW5mb0xpc3QuYmF0Y2hJbmZvIF07XHJcbiAgICByZXR1cm4gYmF0Y2hJbmZvTGlzdDtcclxuICB9KS50aGVuQ2FsbChjYWxsYmFjayk7XHJcblxyXG59O1xyXG5cclxuLyoqXHJcbiAqIENsb3NlIG9wZW5lZCBqb2JcclxuICpcclxuICogQG1ldGhvZCBCdWxrfkpvYiNjbG9zZVxyXG4gKiBAcGFyYW0ge0NhbGxiYWNrLjxCdWxrfkpvYkluZm8+fSBbY2FsbGJhY2tdIC0gQ2FsbGJhY2sgZnVuY3Rpb25cclxuICogQHJldHVybnMge1Byb21pc2UuPEJ1bGt+Sm9iSW5mbz59XHJcbiAqL1xyXG5Kb2IucHJvdG90eXBlLmNsb3NlID0gZnVuY3Rpb24oKSB7XHJcbiAgdmFyIHNlbGYgPSB0aGlzO1xyXG4gIHJldHVybiB0aGlzLl9jaGFuZ2VTdGF0ZShcIkNsb3NlZFwiKS50aGVuKGZ1bmN0aW9uKGpvYkluZm8pIHtcclxuICAgIHNlbGYuaWQgPSBudWxsO1xyXG4gICAgc2VsZi5lbWl0KFwiY2xvc2VcIiwgam9iSW5mbyk7XHJcbiAgICByZXR1cm4gam9iSW5mbztcclxuICB9LCBmdW5jdGlvbihlcnIpIHtcclxuICAgIHNlbGYuZW1pdChcImVycm9yXCIsIGVycik7XHJcbiAgICB0aHJvdyBlcnI7XHJcbiAgfSk7XHJcbn07XHJcblxyXG4vKipcclxuICogU2V0IHRoZSBzdGF0dXMgdG8gYWJvcnRcclxuICpcclxuICogQG1ldGhvZCBCdWxrfkpvYiNhYm9ydFxyXG4gKiBAcGFyYW0ge0NhbGxiYWNrLjxCdWxrfkpvYkluZm8+fSBbY2FsbGJhY2tdIC0gQ2FsbGJhY2sgZnVuY3Rpb25cclxuICogQHJldHVybnMge1Byb21pc2UuPEJ1bGt+Sm9iSW5mbz59XHJcbiAqL1xyXG5Kb2IucHJvdG90eXBlLmFib3J0ID0gZnVuY3Rpb24oKSB7XHJcbiAgdmFyIHNlbGYgPSB0aGlzO1xyXG4gIHJldHVybiB0aGlzLl9jaGFuZ2VTdGF0ZShcIkFib3J0ZWRcIikudGhlbihmdW5jdGlvbihqb2JJbmZvKSB7XHJcbiAgICBzZWxmLmlkID0gbnVsbDtcclxuICAgIHNlbGYuZW1pdChcImFib3J0XCIsIGpvYkluZm8pO1xyXG4gICAgcmV0dXJuIGpvYkluZm87XHJcbiAgfSwgZnVuY3Rpb24oZXJyKSB7XHJcbiAgICBzZWxmLmVtaXQoXCJlcnJvclwiLCBlcnIpO1xyXG4gICAgdGhyb3cgZXJyO1xyXG4gIH0pO1xyXG59O1xyXG5cclxuLyoqXHJcbiAqIEBwcml2YXRlXHJcbiAqL1xyXG5Kb2IucHJvdG90eXBlLl9jaGFuZ2VTdGF0ZSA9IGZ1bmN0aW9uKHN0YXRlLCBjYWxsYmFjaykge1xyXG4gIHZhciBzZWxmID0gdGhpcztcclxuICB2YXIgYnVsayA9IHRoaXMuX2J1bGs7XHJcbiAgdmFyIGxvZ2dlciA9IGJ1bGsuX2xvZ2dlcjtcclxuXHJcbiAgdGhpcy5fam9iSW5mbyA9IHRoaXMuX3dhaXRBc3NpZ24oKS50aGVuKGZ1bmN0aW9uKCkge1xyXG4gICAgdmFyIGJvZHkgPSBbXHJcbiAgICAgICc8P3htbCB2ZXJzaW9uPVwiMS4wXCIgZW5jb2Rpbmc9XCJVVEYtOFwiPz4nLFxyXG4gICAgICAnPGpvYkluZm8geG1sbnM9XCJodHRwOi8vd3d3LmZvcmNlLmNvbS8yMDA5LzA2L2FzeW5jYXBpL2RhdGFsb2FkXCI+JyxcclxuICAgICAgICAnPHN0YXRlPicgKyBzdGF0ZSArICc8L3N0YXRlPicsXHJcbiAgICAgICc8L2pvYkluZm8+J1xyXG4gICAgXS5qb2luKCcnKTtcclxuICAgIHJldHVybiBidWxrLl9yZXF1ZXN0KHtcclxuICAgICAgbWV0aG9kIDogJ1BPU1QnLFxyXG4gICAgICBwYXRoIDogXCIvam9iL1wiICsgc2VsZi5pZCxcclxuICAgICAgYm9keSA6IGJvZHksXHJcbiAgICAgIGhlYWRlcnMgOiB7XHJcbiAgICAgICAgXCJDb250ZW50LVR5cGVcIiA6IFwiYXBwbGljYXRpb24veG1sOyBjaGFyc2V0PXV0Zi04XCJcclxuICAgICAgfSxcclxuICAgICAgcmVzcG9uc2VUeXBlOiBcImFwcGxpY2F0aW9uL3htbFwiXHJcbiAgICB9KTtcclxuICB9KS50aGVuKGZ1bmN0aW9uKHJlcykge1xyXG4gICAgbG9nZ2VyLmRlYnVnKHJlcy5qb2JJbmZvKTtcclxuICAgIHNlbGYuc3RhdGUgPSByZXMuam9iSW5mby5zdGF0ZTtcclxuICAgIHJldHVybiByZXMuam9iSW5mbztcclxuICB9KTtcclxuICByZXR1cm4gdGhpcy5fam9iSW5mby50aGVuQ2FsbChjYWxsYmFjayk7XHJcblxyXG59O1xyXG5cclxuXHJcbi8qLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0qL1xyXG5cclxuLyoqXHJcbiAqIEJhdGNoIChleHRlbmRzIFJlY29yZFN0cmVhbSlcclxuICpcclxuICogQHByb3RlY3RlZFxyXG4gKiBAY2xhc3MgQnVsa35CYXRjaFxyXG4gKiBAZXh0ZW5kcyB7c3RyZWFtLldyaXRhYmxlfVxyXG4gKiBAaW1wbGVtZW50cyB7UHJvbWlzZS48QXJyYXkuPFJlY29yZFJlc3VsdD4+fVxyXG4gKiBAcGFyYW0ge0J1bGt+Sm9ifSBqb2IgLSBCdWxrIGpvYiBvYmplY3RcclxuICogQHBhcmFtIHtTdHJpbmd9IFtiYXRjaElkXSAtIEJhdGNoIElEIChpZiBhbHJlYWR5IGF2YWlsYWJsZSlcclxuICovXHJcbnZhciBCYXRjaCA9IGZ1bmN0aW9uKGpvYiwgYmF0Y2hJZCkge1xyXG4gIEJhdGNoLnN1cGVyXy5jYWxsKHRoaXMsIHsgb2JqZWN0TW9kZTogdHJ1ZSB9KTtcclxuICB0aGlzLmpvYiA9IGpvYjtcclxuICB0aGlzLmlkID0gYmF0Y2hJZDtcclxuICB0aGlzLl9idWxrID0gam9iLl9idWxrO1xyXG4gIHRoaXMuX2RlZmVycmVkID0gUHJvbWlzZS5kZWZlcigpO1xyXG4gIHRoaXMuX3NldHVwRGF0YVN0cmVhbXMoKTtcclxufTtcclxuXHJcbmluaGVyaXRzKEJhdGNoLCBzdHJlYW0uV3JpdGFibGUpO1xyXG5cclxuXHJcbi8qKlxyXG4gKiBAcHJpdmF0ZVxyXG4gKi9cclxuQmF0Y2gucHJvdG90eXBlLl9zZXR1cERhdGFTdHJlYW1zID0gZnVuY3Rpb24oKSB7XHJcbiAgdmFyIGJhdGNoID0gdGhpcztcclxuICB2YXIgY29udmVydGVyT3B0aW9ucyA9IHsgbnVsbFZhbHVlIDogJyNOL0EnIH07XHJcbiAgdGhpcy5fdXBsb2FkU3RyZWFtID0gbmV3IFJlY29yZFN0cmVhbS5TZXJpYWxpemFibGUoKTtcclxuICB0aGlzLl91cGxvYWREYXRhU3RyZWFtID0gdGhpcy5fdXBsb2FkU3RyZWFtLnN0cmVhbSgnY3N2JywgY29udmVydGVyT3B0aW9ucyk7XHJcbiAgdGhpcy5fZG93bmxvYWRTdHJlYW0gPSBuZXcgUmVjb3JkU3RyZWFtLlBhcnNhYmxlKCk7XHJcbiAgdGhpcy5fZG93bmxvYWREYXRhU3RyZWFtID0gdGhpcy5fZG93bmxvYWRTdHJlYW0uc3RyZWFtKCdjc3YnLCBjb252ZXJ0ZXJPcHRpb25zKTtcclxuXHJcbiAgdGhpcy5vbignZmluaXNoJywgZnVuY3Rpb24oKSB7XHJcbiAgICBiYXRjaC5fdXBsb2FkU3RyZWFtLmVuZCgpO1xyXG4gIH0pO1xyXG4gIHRoaXMuX3VwbG9hZERhdGFTdHJlYW0ub25jZSgncmVhZGFibGUnLCBmdW5jdGlvbigpIHtcclxuICAgIGJhdGNoLmpvYi5vcGVuKCkudGhlbihmdW5jdGlvbigpIHtcclxuICAgICAgLy8gcGlwZSB1cGxvYWQgZGF0YSB0byBiYXRjaCBBUEkgcmVxdWVzdCBzdHJlYW1cclxuICAgICAgYmF0Y2guX3VwbG9hZERhdGFTdHJlYW0ucGlwZShiYXRjaC5fY3JlYXRlUmVxdWVzdFN0cmVhbSgpKTtcclxuICAgIH0pO1xyXG4gIH0pO1xyXG5cclxuICAvLyBkdXBsZXggZGF0YSBzdHJlYW0sIG9wZW5lZCBhY2Nlc3MgdG8gQVBJIHByb2dyYW1tZXJzIGJ5IEJhdGNoI3N0cmVhbSgpXHJcbiAgdmFyIGRhdGFTdHJlYW0gPSB0aGlzLl9kYXRhU3RyZWFtID0gbmV3IER1cGxleCgpO1xyXG4gIGRhdGFTdHJlYW0uX3dyaXRlID0gZnVuY3Rpb24oZGF0YSwgZW5jLCBjYikge1xyXG4gICAgYmF0Y2guX3VwbG9hZERhdGFTdHJlYW0ud3JpdGUoZGF0YSwgZW5jLCBjYik7XHJcbiAgfTtcclxuICBkYXRhU3RyZWFtLm9uKCdmaW5pc2gnLCBmdW5jdGlvbigpIHtcclxuICAgIGJhdGNoLl91cGxvYWREYXRhU3RyZWFtLmVuZCgpO1xyXG4gIH0pO1xyXG5cclxuICB0aGlzLl9kb3dubG9hZERhdGFTdHJlYW0ub24oJ3JlYWRhYmxlJywgZnVuY3Rpb24oKSB7XHJcbiAgICBkYXRhU3RyZWFtLnJlYWQoMCk7XHJcbiAgfSk7XHJcbiAgdGhpcy5fZG93bmxvYWREYXRhU3RyZWFtLm9uKCdlbmQnLCBmdW5jdGlvbigpIHtcclxuICAgIGRhdGFTdHJlYW0ucHVzaChudWxsKTtcclxuICB9KTtcclxuICBkYXRhU3RyZWFtLl9yZWFkID0gZnVuY3Rpb24oc2l6ZSkge1xyXG4gICAgdmFyIGNodW5rO1xyXG4gICAgd2hpbGUgKChjaHVuayA9IGJhdGNoLl9kb3dubG9hZERhdGFTdHJlYW0ucmVhZCgpKSAhPT0gbnVsbCkge1xyXG4gICAgICBkYXRhU3RyZWFtLnB1c2goY2h1bmspO1xyXG4gICAgfVxyXG4gIH07XHJcbn07XHJcblxyXG4vKipcclxuICogQ29ubmVjdCBiYXRjaCBBUEkgYW5kIGNyZWF0ZSBzdHJlYW0gaW5zdGFuY2Ugb2YgcmVxdWVzdC9yZXNwb25zZVxyXG4gKlxyXG4gKiBAcHJpdmF0ZVxyXG4gKiBAcmV0dXJucyB7c3RyZWFtLkR1cGxleH1cclxuICovXHJcbkJhdGNoLnByb3RvdHlwZS5fY3JlYXRlUmVxdWVzdFN0cmVhbSA9IGZ1bmN0aW9uKCkge1xyXG4gIHZhciBiYXRjaCA9IHRoaXM7XHJcbiAgdmFyIGJ1bGsgPSBiYXRjaC5fYnVsaztcclxuICB2YXIgbG9nZ2VyID0gYnVsay5fbG9nZ2VyO1xyXG5cclxuICByZXR1cm4gYnVsay5fcmVxdWVzdCh7XHJcbiAgICBtZXRob2QgOiAnUE9TVCcsXHJcbiAgICBwYXRoIDogXCIvam9iL1wiICsgYmF0Y2guam9iLmlkICsgXCIvYmF0Y2hcIixcclxuICAgIGhlYWRlcnM6IHtcclxuICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJ0ZXh0L2NzdlwiXHJcbiAgICB9LFxyXG4gICAgcmVzcG9uc2VUeXBlOiBcImFwcGxpY2F0aW9uL3htbFwiXHJcbiAgfSwgZnVuY3Rpb24oZXJyLCByZXMpIHtcclxuICAgIGlmIChlcnIpIHtcclxuICAgICAgYmF0Y2guZW1pdCgnZXJyb3InLCBlcnIpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgbG9nZ2VyLmRlYnVnKHJlcy5iYXRjaEluZm8pO1xyXG4gICAgICBiYXRjaC5pZCA9IHJlcy5iYXRjaEluZm8uaWQ7XHJcbiAgICAgIGJhdGNoLmVtaXQoJ3F1ZXVlJywgcmVzLmJhdGNoSW5mbyk7XHJcbiAgICB9XHJcbiAgfSkuc3RyZWFtKCk7XHJcbn07XHJcblxyXG4vKipcclxuICogSW1wbGVtZW50YXRpb24gb2YgV3JpdGFibGVcclxuICpcclxuICogQG92ZXJyaWRlXHJcbiAqIEBwcml2YXRlXHJcbiAqL1xyXG5CYXRjaC5wcm90b3R5cGUuX3dyaXRlID0gZnVuY3Rpb24ocmVjb3JkLCBlbmMsIGNiKSB7XHJcbiAgcmVjb3JkID0gXy5jbG9uZShyZWNvcmQpO1xyXG4gIGlmICh0aGlzLmpvYi5vcGVyYXRpb24gPT09IFwiaW5zZXJ0XCIpIHtcclxuICAgIGRlbGV0ZSByZWNvcmQuSWQ7XHJcbiAgfSBlbHNlIGlmICh0aGlzLmpvYi5vcGVyYXRpb24gPT09IFwiZGVsZXRlXCIpIHtcclxuICAgIHJlY29yZCA9IHsgSWQ6IHJlY29yZC5JZCB9O1xyXG4gIH1cclxuICBkZWxldGUgcmVjb3JkLnR5cGU7XHJcbiAgZGVsZXRlIHJlY29yZC5hdHRyaWJ1dGVzO1xyXG4gIHRoaXMuX3VwbG9hZFN0cmVhbS53cml0ZShyZWNvcmQsIGVuYywgY2IpO1xyXG59O1xyXG5cclxuLyoqXHJcbiAqIFJldHVybnMgZHVwbGV4IHN0cmVhbSB3aGljaCBhY2NlcHRzIENTViBkYXRhIGlucHV0IGFuZCBiYXRjaCByZXN1bHQgb3V0cHV0XHJcbiAqXHJcbiAqIEByZXR1cm5zIHtzdHJlYW0uRHVwbGV4fVxyXG4gKi9cclxuQmF0Y2gucHJvdG90eXBlLnN0cmVhbSA9IGZ1bmN0aW9uKCkge1xyXG4gIHJldHVybiB0aGlzLl9kYXRhU3RyZWFtO1xyXG59O1xyXG5cclxuLyoqXHJcbiAqIEV4ZWN1dGUgYmF0Y2ggb3BlcmF0aW9uXHJcbiAqXHJcbiAqIEBtZXRob2QgQnVsa35CYXRjaCNleGVjdXRlXHJcbiAqIEBwYXJhbSB7QXJyYXkuPFJlY29yZD58c3RyZWFtLlN0cmVhbXxTdHJpbmd9IFtpbnB1dF0gLSBJbnB1dCBzb3VyY2UgZm9yIGJhdGNoIG9wZXJhdGlvbi4gQWNjZXB0cyBhcnJheSBvZiByZWNvcmRzLCBDU1Ygc3RyaW5nLCBhbmQgQ1NWIGRhdGEgaW5wdXQgc3RyZWFtIGluIGluc2VydC91cGRhdGUvdXBzZXJ0L2RlbGV0ZS9oYXJkRGVsZXRlIG9wZXJhdGlvbiwgU09RTCBzdHJpbmcgaW4gcXVlcnkgb3BlcmF0aW9uLlxyXG4gKiBAcGFyYW0ge0NhbGxiYWNrLjxBcnJheS48UmVjb3JkUmVzdWx0PnxBcnJheS48QmF0Y2hSZXN1bHRJbmZvPj59IFtjYWxsYmFja10gLSBDYWxsYmFjayBmdW5jdGlvblxyXG4gKiBAcmV0dXJucyB7QnVsa35CYXRjaH1cclxuICovXHJcbkJhdGNoLnByb3RvdHlwZS5ydW4gPVxyXG5CYXRjaC5wcm90b3R5cGUuZXhlYyA9XHJcbkJhdGNoLnByb3RvdHlwZS5leGVjdXRlID0gZnVuY3Rpb24oaW5wdXQsIGNhbGxiYWNrKSB7XHJcbiAgdmFyIHNlbGYgPSB0aGlzO1xyXG5cclxuICBpZiAodHlwZW9mIGlucHV0ID09PSAnZnVuY3Rpb24nKSB7IC8vIGlmIGlucHV0IGFyZ3VtZW50IGlzIG9taXR0ZWRcclxuICAgIGNhbGxiYWNrID0gaW5wdXQ7XHJcbiAgICBpbnB1dCA9IG51bGw7XHJcbiAgfVxyXG5cclxuICAvLyBpZiBiYXRjaCBpcyBhbHJlYWR5IGV4ZWN1dGVkXHJcbiAgaWYgKHRoaXMuX3Jlc3VsdCkge1xyXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQmF0Y2ggYWxyZWFkeSBleGVjdXRlZC5cIik7XHJcbiAgfVxyXG5cclxuICB2YXIgcmRlZmVycmVkID0gUHJvbWlzZS5kZWZlcigpO1xyXG4gIHRoaXMuX3Jlc3VsdCA9IHJkZWZlcnJlZC5wcm9taXNlO1xyXG4gIHRoaXMuX3Jlc3VsdC50aGVuKGZ1bmN0aW9uKHJlcykge1xyXG4gICAgc2VsZi5fZGVmZXJyZWQucmVzb2x2ZShyZXMpO1xyXG4gIH0sIGZ1bmN0aW9uKGVycikge1xyXG4gICAgc2VsZi5fZGVmZXJyZWQucmVqZWN0KGVycik7XHJcbiAgfSk7XHJcbiAgdGhpcy5vbmNlKCdyZXNwb25zZScsIGZ1bmN0aW9uKHJlcykge1xyXG4gICAgcmRlZmVycmVkLnJlc29sdmUocmVzKTtcclxuICB9KTtcclxuICB0aGlzLm9uY2UoJ2Vycm9yJywgZnVuY3Rpb24oZXJyKSB7XHJcbiAgICByZGVmZXJyZWQucmVqZWN0KGVycik7XHJcbiAgfSk7XHJcblxyXG4gIGlmIChfLmlzT2JqZWN0KGlucHV0KSAmJiBfLmlzRnVuY3Rpb24oaW5wdXQucGlwZSkpIHsgLy8gaWYgaW5wdXQgaGFzIHN0cmVhbS5SZWFkYWJsZSBpbnRlcmZhY2VcclxuICAgIGlucHV0LnBpcGUodGhpcy5fZGF0YVN0cmVhbSk7XHJcbiAgfSBlbHNlIHtcclxuICAgIHZhciBkYXRhO1xyXG4gICAgaWYgKF8uaXNBcnJheShpbnB1dCkpIHtcclxuICAgICAgXy5mb3JFYWNoKGlucHV0LCBmdW5jdGlvbihyZWNvcmQpIHtcclxuICAgICAgICBPYmplY3Qua2V5cyhyZWNvcmQpLmZvckVhY2goZnVuY3Rpb24oa2V5KSB7XHJcbiAgICAgICAgICBpZiAodHlwZW9mIHJlY29yZFtrZXldID09PSAnYm9vbGVhbicpIHtcclxuICAgICAgICAgICAgcmVjb3JkW2tleV0gPSBTdHJpbmcocmVjb3JkW2tleV0pXHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfSlcclxuICAgICAgICBzZWxmLndyaXRlKHJlY29yZCk7XHJcbiAgICAgIH0pO1xyXG4gICAgICBzZWxmLmVuZCgpO1xyXG4gICAgfSBlbHNlIGlmIChfLmlzU3RyaW5nKGlucHV0KSl7XHJcbiAgICAgIGRhdGEgPSBpbnB1dDtcclxuICAgICAgdGhpcy5fZGF0YVN0cmVhbS53cml0ZShkYXRhLCAndXRmOCcpO1xyXG4gICAgICB0aGlzLl9kYXRhU3RyZWFtLmVuZCgpO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLy8gcmV0dXJuIEJhdGNoIGluc3RhbmNlIGZvciBjaGFpbmluZ1xyXG4gIHJldHVybiB0aGlzLnRoZW5DYWxsKGNhbGxiYWNrKTtcclxufTtcclxuXHJcbi8qKlxyXG4gKiBQcm9taXNlL0ErIGludGVyZmFjZVxyXG4gKiBodHRwOi8vcHJvbWlzZXMtYXBsdXMuZ2l0aHViLmlvL3Byb21pc2VzLXNwZWMvXHJcbiAqXHJcbiAqIERlbGVnYXRlIHRvIGRlZmVycmVkIHByb21pc2UsIHJldHVybiBwcm9taXNlIGluc3RhbmNlIGZvciBiYXRjaCByZXN1bHRcclxuICpcclxuICogQG1ldGhvZCBCdWxrfkJhdGNoI3RoZW5cclxuICovXHJcbkJhdGNoLnByb3RvdHlwZS50aGVuID0gZnVuY3Rpb24ob25SZXNvbHZlZCwgb25SZWplY3QsIG9uUHJvZ3Jlc3MpIHtcclxuICByZXR1cm4gdGhpcy5fZGVmZXJyZWQucHJvbWlzZS50aGVuKG9uUmVzb2x2ZWQsIG9uUmVqZWN0LCBvblByb2dyZXNzKTtcclxufTtcclxuXHJcbi8qKlxyXG4gKiBQcm9taXNlL0ErIGV4dGVuc2lvblxyXG4gKiBDYWxsIFwidGhlblwiIHVzaW5nIGdpdmVuIG5vZGUtc3R5bGUgY2FsbGJhY2sgZnVuY3Rpb25cclxuICpcclxuICogQG1ldGhvZCBCdWxrfkJhdGNoI3RoZW5DYWxsXHJcbiAqL1xyXG5CYXRjaC5wcm90b3R5cGUudGhlbkNhbGwgPSBmdW5jdGlvbihjYWxsYmFjaykge1xyXG4gIGlmIChfLmlzRnVuY3Rpb24oY2FsbGJhY2spKSB7XHJcbiAgICB0aGlzLnRoZW4oZnVuY3Rpb24ocmVzKSB7XHJcbiAgICAgIHByb2Nlc3MubmV4dFRpY2soZnVuY3Rpb24oKSB7XHJcbiAgICAgICAgY2FsbGJhY2sobnVsbCwgcmVzKTtcclxuICAgICAgfSk7XHJcbiAgICB9LCBmdW5jdGlvbihlcnIpIHtcclxuICAgICAgcHJvY2Vzcy5uZXh0VGljayhmdW5jdGlvbigpIHtcclxuICAgICAgICBjYWxsYmFjayhlcnIpO1xyXG4gICAgICB9KTtcclxuICAgIH0pO1xyXG4gIH1cclxuICByZXR1cm4gdGhpcztcclxufTtcclxuXHJcbi8qKlxyXG4gKiBAdHlwZWRlZiB7T2JqZWN0fSBCdWxrfkJhdGNoSW5mb1xyXG4gKiBAcHJvcCB7U3RyaW5nfSBpZCAtIEJhdGNoIElEXHJcbiAqIEBwcm9wIHtTdHJpbmd9IGpvYklkIC0gSm9iIElEXHJcbiAqIEBwcm9wIHtTdHJpbmd9IHN0YXRlIC0gQmF0Y2ggc3RhdGVcclxuICogQHByb3Age1N0cmluZ30gc3RhdGVNZXNzYWdlIC0gQmF0Y2ggc3RhdGUgbWVzc2FnZVxyXG4gKi9cclxuXHJcbi8qKlxyXG4gKiBDaGVjayB0aGUgbGF0ZXN0IGJhdGNoIHN0YXR1cyBpbiBzZXJ2ZXJcclxuICpcclxuICogQG1ldGhvZCBCdWxrfkJhdGNoI2NoZWNrXHJcbiAqIEBwYXJhbSB7Q2FsbGJhY2suPEJ1bGt+QmF0Y2hJbmZvPn0gW2NhbGxiYWNrXSAtIENhbGxiYWNrIGZ1bmN0aW9uXHJcbiAqIEByZXR1cm5zIHtQcm9taXNlLjxCdWxrfkJhdGNoSW5mbz59XHJcbiAqL1xyXG5CYXRjaC5wcm90b3R5cGUuY2hlY2sgPSBmdW5jdGlvbihjYWxsYmFjaykge1xyXG4gIHZhciBzZWxmID0gdGhpcztcclxuICB2YXIgYnVsayA9IHRoaXMuX2J1bGs7XHJcbiAgdmFyIGxvZ2dlciA9IGJ1bGsuX2xvZ2dlcjtcclxuICB2YXIgam9iSWQgPSB0aGlzLmpvYi5pZDtcclxuICB2YXIgYmF0Y2hJZCA9IHRoaXMuaWQ7XHJcblxyXG4gIGlmICgham9iSWQgfHwgIWJhdGNoSWQpIHtcclxuICAgIHRocm93IG5ldyBFcnJvcihcIkJhdGNoIG5vdCBzdGFydGVkLlwiKTtcclxuICB9XHJcbiAgcmV0dXJuIGJ1bGsuX3JlcXVlc3Qoe1xyXG4gICAgbWV0aG9kIDogJ0dFVCcsXHJcbiAgICBwYXRoIDogXCIvam9iL1wiICsgam9iSWQgKyBcIi9iYXRjaC9cIiArIGJhdGNoSWQsXHJcbiAgICByZXNwb25zZVR5cGU6IFwiYXBwbGljYXRpb24veG1sXCJcclxuICB9KS50aGVuKGZ1bmN0aW9uKHJlcykge1xyXG4gICAgbG9nZ2VyLmRlYnVnKHJlcy5iYXRjaEluZm8pO1xyXG4gICAgcmV0dXJuIHJlcy5iYXRjaEluZm87XHJcbiAgfSkudGhlbkNhbGwoY2FsbGJhY2spO1xyXG59O1xyXG5cclxuXHJcbi8qKlxyXG4gKiBQb2xsaW5nIHRoZSBiYXRjaCByZXN1bHQgYW5kIHJldHJpZXZlXHJcbiAqXHJcbiAqIEBtZXRob2QgQnVsa35CYXRjaCNwb2xsXHJcbiAqIEBwYXJhbSB7TnVtYmVyfSBpbnRlcnZhbCAtIFBvbGxpbmcgaW50ZXJ2YWwgaW4gbWlsbGlzZWNvbmRzXHJcbiAqIEBwYXJhbSB7TnVtYmVyfSB0aW1lb3V0IC0gUG9sbGluZyB0aW1lb3V0IGluIG1pbGxpc2Vjb25kc1xyXG4gKi9cclxuQmF0Y2gucHJvdG90eXBlLnBvbGwgPSBmdW5jdGlvbihpbnRlcnZhbCwgdGltZW91dCkge1xyXG4gIHZhciBzZWxmID0gdGhpcztcclxuICB2YXIgam9iSWQgPSB0aGlzLmpvYi5pZDtcclxuICB2YXIgYmF0Y2hJZCA9IHRoaXMuaWQ7XHJcblxyXG4gIGlmICgham9iSWQgfHwgIWJhdGNoSWQpIHtcclxuICAgIHRocm93IG5ldyBFcnJvcihcIkJhdGNoIG5vdCBzdGFydGVkLlwiKTtcclxuICB9XHJcbiAgdmFyIHN0YXJ0VGltZSA9IG5ldyBEYXRlKCkuZ2V0VGltZSgpO1xyXG4gIHZhciBwb2xsID0gZnVuY3Rpb24oKSB7XHJcbiAgICB2YXIgbm93ID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XHJcbiAgICBpZiAoc3RhcnRUaW1lICsgdGltZW91dCA8IG5vdykge1xyXG4gICAgICB2YXIgZXJyID0gbmV3IEVycm9yKFwiUG9sbGluZyB0aW1lIG91dC4gSm9iIElkID0gXCIgKyBqb2JJZCArIFwiICwgYmF0Y2ggSWQgPSBcIiArIGJhdGNoSWQpO1xyXG4gICAgICBlcnIubmFtZSA9ICdQb2xsaW5nVGltZW91dCc7XHJcbiAgICAgIGVyci5qb2JJZCA9IGpvYklkO1xyXG4gICAgICBlcnIuYmF0Y2hJZCA9IGJhdGNoSWQ7XHJcbiAgICAgIHNlbGYuZW1pdCgnZXJyb3InLCBlcnIpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBzZWxmLmNoZWNrKGZ1bmN0aW9uKGVyciwgcmVzKSB7XHJcbiAgICAgIGlmIChlcnIpIHtcclxuICAgICAgICBzZWxmLmVtaXQoJ2Vycm9yJywgZXJyKTtcclxuICAgICAgfSBlbHNlIHtcclxuICAgICAgICBpZiAocmVzLnN0YXRlID09PSBcIkZhaWxlZFwiKSB7XHJcbiAgICAgICAgICBpZiAocGFyc2VJbnQocmVzLm51bWJlclJlY29yZHNQcm9jZXNzZWQsIDEwKSA+IDApIHtcclxuICAgICAgICAgICAgc2VsZi5yZXRyaWV2ZSgpO1xyXG4gICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgc2VsZi5lbWl0KCdlcnJvcicsIG5ldyBFcnJvcihyZXMuc3RhdGVNZXNzYWdlKSk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfSBlbHNlIGlmIChyZXMuc3RhdGUgPT09IFwiQ29tcGxldGVkXCIpIHtcclxuICAgICAgICAgIHNlbGYucmV0cmlldmUoKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgc2VsZi5lbWl0KCdwcm9ncmVzcycsIHJlcyk7XHJcbiAgICAgICAgICBpZiAoc2VsZi5wb2xsSGFuZGxlKSB7XHJcbiAgICAgICAgICAgIHNlbGYucG9sbEhhbmRsZSA9IHNldFRpbWVvdXQocG9sbCwgaW50ZXJ2YWwpO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgfTtcclxuICB0aGlzLnBvbGxIYW5kbGUgPSBzZXRUaW1lb3V0KHBvbGwsIGludGVydmFsKTtcclxufTtcclxuXHJcbi8qKlxyXG4gKiBTdG9wcyBwb2xsaW5nIHRoZSBjdXJyZW50IGJhdGNoIGZvciBwcm9ncmVzcy4gQ2FsbCB0aGlzIHRvIHN0b3AgYHBvbGxgIGFuZCBicmVhayB0aGUgcG9sbGluZyBsb29wLlxyXG4gKi9cclxuQmF0Y2gucHJvdG90eXBlLnBvbGxTdG9wID0gZnVuY3Rpb24oKSB7XHJcbiAgaWYgKCF0aGlzLnBvbGxIYW5kbGUpIHtcclxuICAgIHRocm93IG5ldyBFcnJvcihcIlBvbGxpbmcgbm90IHN0YXJ0ZWQuXCIpO1xyXG4gIH1cclxuICBjbGVhclRpbWVvdXQodGhpcy5wb2xsSGFuZGxlKTtcclxuICB0aGlzLnBvbGxIYW5kbGUgPSB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBAdHlwZWRlZiB7T2JqZWN0fSBCdWxrfkJhdGNoUmVzdWx0SW5mb1xyXG4gKiBAcHJvcCB7U3RyaW5nfSBpZCAtIEJhdGNoIHJlc3VsdCBJRFxyXG4gKiBAcHJvcCB7U3RyaW5nfSBiYXRjaElkIC0gQmF0Y2ggSUQgd2hpY2ggaW5jbHVkZXMgdGhpcyBiYXRjaCByZXN1bHQuXHJcbiAqIEBwcm9wIHtTdHJpbmd9IGpvYklkIC0gSm9iIElEIHdoaWNoIGluY2x1ZGVzIHRoaXMgYmF0Y2ggcmVzdWx0LlxyXG4gKi9cclxuXHJcbi8qKlxyXG4gKiBSZXRyaWV2ZSBiYXRjaCByZXN1bHRcclxuICpcclxuICogQG1ldGhvZCBCdWxrfkJhdGNoI3JldHJpZXZlXHJcbiAqIEBwYXJhbSB7Q2FsbGJhY2suPEFycmF5LjxSZWNvcmRSZXN1bHQ+fEFycmF5LjxCdWxrfkJhdGNoUmVzdWx0SW5mbz4+fSBbY2FsbGJhY2tdIC0gQ2FsbGJhY2sgZnVuY3Rpb25cclxuICogQHJldHVybnMge1Byb21pc2UuPEFycmF5LjxSZWNvcmRSZXN1bHQ+fEFycmF5LjxCdWxrfkJhdGNoUmVzdWx0SW5mbz4+fVxyXG4gKi9cclxuQmF0Y2gucHJvdG90eXBlLnJldHJpZXZlID0gZnVuY3Rpb24oY2FsbGJhY2spIHtcclxuICB2YXIgc2VsZiA9IHRoaXM7XHJcbiAgdmFyIGJ1bGsgPSB0aGlzLl9idWxrO1xyXG4gIHZhciBqb2JJZCA9IHRoaXMuam9iLmlkO1xyXG4gIHZhciBqb2IgPSB0aGlzLmpvYjtcclxuICB2YXIgYmF0Y2hJZCA9IHRoaXMuaWQ7XHJcblxyXG4gIGlmICgham9iSWQgfHwgIWJhdGNoSWQpIHtcclxuICAgIHRocm93IG5ldyBFcnJvcihcIkJhdGNoIG5vdCBzdGFydGVkLlwiKTtcclxuICB9XHJcblxyXG4gIHJldHVybiBqb2IuaW5mbygpLnRoZW4oZnVuY3Rpb24oam9iSW5mbykge1xyXG4gICAgcmV0dXJuIGJ1bGsuX3JlcXVlc3Qoe1xyXG4gICAgICBtZXRob2QgOiAnR0VUJyxcclxuICAgICAgcGF0aCA6IFwiL2pvYi9cIiArIGpvYklkICsgXCIvYmF0Y2gvXCIgKyBiYXRjaElkICsgXCIvcmVzdWx0XCJcclxuICAgIH0pO1xyXG4gIH0pLnRoZW4oZnVuY3Rpb24ocmVzKSB7XHJcbiAgICB2YXIgcmVzdWx0cztcclxuICAgIGlmIChqb2Iub3BlcmF0aW9uID09PSAncXVlcnknKSB7XHJcbiAgICAgIHZhciBjb25uID0gYnVsay5fY29ubjtcclxuICAgICAgdmFyIHJlc3VsdElkcyA9IHJlc1sncmVzdWx0LWxpc3QnXS5yZXN1bHQ7XHJcbiAgICAgIHJlc3VsdHMgPSByZXNbJ3Jlc3VsdC1saXN0J10ucmVzdWx0O1xyXG4gICAgICByZXN1bHRzID0gXy5tYXAoXy5pc0FycmF5KHJlc3VsdHMpID8gcmVzdWx0cyA6IFsgcmVzdWx0cyBdLCBmdW5jdGlvbihpZCkge1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICBpZDogaWQsXHJcbiAgICAgICAgICBiYXRjaElkOiBiYXRjaElkLFxyXG4gICAgICAgICAgam9iSWQ6IGpvYklkXHJcbiAgICAgICAgfTtcclxuICAgICAgfSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICByZXN1bHRzID0gXy5tYXAocmVzLCBmdW5jdGlvbihyZXQpIHtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgaWQ6IHJldC5JZCB8fCBudWxsLFxyXG4gICAgICAgICAgc3VjY2VzczogcmV0LlN1Y2Nlc3MgPT09IFwidHJ1ZVwiLFxyXG4gICAgICAgICAgZXJyb3JzOiByZXQuRXJyb3IgPyBbIHJldC5FcnJvciBdIDogW11cclxuICAgICAgICB9O1xyXG4gICAgICB9KTtcclxuICAgIH1cclxuICAgIHNlbGYuZW1pdCgncmVzcG9uc2UnLCByZXN1bHRzKTtcclxuICAgIHJldHVybiByZXN1bHRzO1xyXG4gIH0pLmZhaWwoZnVuY3Rpb24oZXJyKSB7XHJcbiAgICBzZWxmLmVtaXQoJ2Vycm9yJywgZXJyKTtcclxuICAgIHRocm93IGVycjtcclxuICB9KS50aGVuQ2FsbChjYWxsYmFjayk7XHJcbn07XHJcblxyXG4vKipcclxuICogRmV0Y2ggcXVlcnkgcmVzdWx0IGFzIGEgcmVjb3JkIHN0cmVhbVxyXG4gKiBAcGFyYW0ge1N0cmluZ30gcmVzdWx0SWQgLSBSZXN1bHQgaWRcclxuICogQHJldHVybnMge1JlY29yZFN0cmVhbX0gLSBSZWNvcmQgc3RyZWFtLCBjb252ZXJ0aWJsZSB0byBDU1YgZGF0YSBzdHJlYW1cclxuICovXHJcbkJhdGNoLnByb3RvdHlwZS5yZXN1bHQgPSBmdW5jdGlvbihyZXN1bHRJZCkge1xyXG4gIHZhciBqb2JJZCA9IHRoaXMuam9iLmlkO1xyXG4gIHZhciBiYXRjaElkID0gdGhpcy5pZDtcclxuICBpZiAoIWpvYklkIHx8ICFiYXRjaElkKSB7XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJCYXRjaCBub3Qgc3RhcnRlZC5cIik7XHJcbiAgfVxyXG4gIHZhciByZXN1bHRTdHJlYW0gPSBuZXcgUmVjb3JkU3RyZWFtLlBhcnNhYmxlKCk7XHJcbiAgdmFyIHJlc3VsdERhdGFTdHJlYW0gPSByZXN1bHRTdHJlYW0uc3RyZWFtKCdjc3YnKTtcclxuICB2YXIgcmVxU3RyZWFtID0gdGhpcy5fYnVsay5fcmVxdWVzdCh7XHJcbiAgICBtZXRob2QgOiAnR0VUJyxcclxuICAgIHBhdGggOiBcIi9qb2IvXCIgKyBqb2JJZCArIFwiL2JhdGNoL1wiICsgYmF0Y2hJZCArIFwiL3Jlc3VsdC9cIiArIHJlc3VsdElkLFxyXG4gICAgcmVzcG9uc2VUeXBlOiBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiXHJcbiAgfSkuc3RyZWFtKCkucGlwZShyZXN1bHREYXRhU3RyZWFtKTtcclxuICByZXR1cm4gcmVzdWx0U3RyZWFtO1xyXG59O1xyXG5cclxuLyotLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSovXHJcbi8qKlxyXG4gKiBAcHJpdmF0ZVxyXG4gKi9cclxudmFyIEJ1bGtBcGkgPSBmdW5jdGlvbigpIHtcclxuICBCdWxrQXBpLnN1cGVyXy5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xyXG59O1xyXG5cclxuaW5oZXJpdHMoQnVsa0FwaSwgSHR0cEFwaSk7XHJcblxyXG5CdWxrQXBpLnByb3RvdHlwZS5iZWZvcmVTZW5kID0gZnVuY3Rpb24ocmVxdWVzdCkge1xyXG4gIHJlcXVlc3QuaGVhZGVycyA9IHJlcXVlc3QuaGVhZGVycyB8fCB7fTtcclxuICByZXF1ZXN0LmhlYWRlcnNbXCJYLVNGREMtU0VTU0lPTlwiXSA9IHRoaXMuX2Nvbm4uYWNjZXNzVG9rZW47XHJcbn07XHJcblxyXG5CdWxrQXBpLnByb3RvdHlwZS5pc1Nlc3Npb25FeHBpcmVkID0gZnVuY3Rpb24ocmVzcG9uc2UpIHtcclxuICByZXR1cm4gcmVzcG9uc2Uuc3RhdHVzQ29kZSA9PT0gNDAwICYmXHJcbiAgICAvPGV4Y2VwdGlvbkNvZGU+SW52YWxpZFNlc3Npb25JZDxcXC9leGNlcHRpb25Db2RlPi8udGVzdChyZXNwb25zZS5ib2R5KTtcclxufTtcclxuXHJcbkJ1bGtBcGkucHJvdG90eXBlLmhhc0Vycm9ySW5SZXNwb25zZUJvZHkgPSBmdW5jdGlvbihib2R5KSB7XHJcbiAgcmV0dXJuICEhYm9keS5lcnJvcjtcclxufTtcclxuXHJcbkJ1bGtBcGkucHJvdG90eXBlLnBhcnNlRXJyb3IgPSBmdW5jdGlvbihib2R5KSB7XHJcbiAgcmV0dXJuIHtcclxuICAgIGVycm9yQ29kZTogYm9keS5lcnJvci5leGNlcHRpb25Db2RlLFxyXG4gICAgbWVzc2FnZTogYm9keS5lcnJvci5leGNlcHRpb25NZXNzYWdlXHJcbiAgfTtcclxufTtcclxuXHJcbi8qLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0qL1xyXG5cclxuLyoqXHJcbiAqIENsYXNzIGZvciBCdWxrIEFQSVxyXG4gKlxyXG4gKiBAY2xhc3NcclxuICogQHBhcmFtIHtDb25uZWN0aW9ufSBjb25uIC0gQ29ubmVjdGlvbiBvYmplY3RcclxuICovXHJcbnZhciBCdWxrID0gZnVuY3Rpb24oY29ubikge1xyXG4gIHRoaXMuX2Nvbm4gPSBjb25uO1xyXG4gIHRoaXMuX2xvZ2dlciA9IGNvbm4uX2xvZ2dlcjtcclxufTtcclxuXHJcbi8qKlxyXG4gKiBQb2xsaW5nIGludGVydmFsIGluIG1pbGxpc2Vjb25kc1xyXG4gKiBAdHlwZSB7TnVtYmVyfVxyXG4gKi9cclxuQnVsay5wcm90b3R5cGUucG9sbEludGVydmFsID0gMTAwMDtcclxuXHJcbi8qKlxyXG4gKiBQb2xsaW5nIHRpbWVvdXQgaW4gbWlsbGlzZWNvbmRzXHJcbiAqIEB0eXBlIHtOdW1iZXJ9XHJcbiAqL1xyXG5CdWxrLnByb3RvdHlwZS5wb2xsVGltZW91dCA9IDEwMDAwO1xyXG5cclxuLyoqIEBwcml2YXRlICoqL1xyXG5CdWxrLnByb3RvdHlwZS5fcmVxdWVzdCA9IGZ1bmN0aW9uKHJlcXVlc3QsIGNhbGxiYWNrKSB7XHJcbiAgdmFyIGNvbm4gPSB0aGlzLl9jb25uO1xyXG4gIHJlcXVlc3QgPSBfLmNsb25lKHJlcXVlc3QpO1xyXG4gIHZhciBiYXNlVXJsID0gWyBjb25uLmluc3RhbmNlVXJsLCBcInNlcnZpY2VzL2FzeW5jXCIsIGNvbm4udmVyc2lvbiBdLmpvaW4oJy8nKTtcclxuICByZXF1ZXN0LnVybCA9IGJhc2VVcmwgKyByZXF1ZXN0LnBhdGg7XHJcbiAgdmFyIG9wdGlvbnMgPSB7IHJlc3BvbnNlVHlwZTogcmVxdWVzdC5yZXNwb25zZVR5cGUgfTtcclxuICBkZWxldGUgcmVxdWVzdC5wYXRoO1xyXG4gIGRlbGV0ZSByZXF1ZXN0LnJlc3BvbnNlVHlwZTtcclxuICByZXR1cm4gbmV3IEJ1bGtBcGkodGhpcy5fY29ubiwgb3B0aW9ucykucmVxdWVzdChyZXF1ZXN0KS50aGVuQ2FsbChjYWxsYmFjayk7XHJcbn07XHJcblxyXG4vKipcclxuICogQ3JlYXRlIGFuZCBzdGFydCBidWxrbG9hZCBqb2IgYW5kIGJhdGNoXHJcbiAqXHJcbiAqIEBwYXJhbSB7U3RyaW5nfSB0eXBlIC0gU09iamVjdCB0eXBlXHJcbiAqIEBwYXJhbSB7U3RyaW5nfSBvcGVyYXRpb24gLSBCdWxrIGxvYWQgb3BlcmF0aW9uICgnaW5zZXJ0JywgJ3VwZGF0ZScsICd1cHNlcnQnLCAnZGVsZXRlJywgb3IgJ2hhcmREZWxldGUnKVxyXG4gKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIC0gT3B0aW9ucyBmb3IgYnVsayBsb2FkaW5nIG9wZXJhdGlvblxyXG4gKiBAcGFyYW0ge1N0cmluZ30gW29wdGlvbnMuZXh0SWRGaWVsZF0gLSBFeHRlcm5hbCBJRCBmaWVsZCBuYW1lICh1c2VkIHdoZW4gdXBzZXJ0IG9wZXJhdGlvbikuXHJcbiAqIEBwYXJhbSB7U3RyaW5nfSBbb3B0aW9ucy5jb25jdXJyZW5jeU1vZGVdIC0gJ1NlcmlhbCcgb3IgJ1BhcmFsbGVsJy4gRGVmYXVsdHMgdG8gUGFyYWxsZWwuXHJcbiAqIEBwYXJhbSB7Qm9vbGVhbn0gW29wdGlvbnMucGtDaHVua2luZ10gLSBFbmFibGVzIFBLIENodW5raW5nIGZvciBCdWxrIEFQSSBRdWVyeS4gRGVmYXVsdHMgdG8gZmFsc2UuIFVzZSBjaHVua1NpemUgdG8gY2hhbmdlIHRoZSBkZWZhdWx0IGNodW5rIHNpemUuXHJcbiAqIEBwYXJhbSB7TnVtYmVyfSBbb3B0aW9ucy5jaHVua1NpemVdIC0gQ2h1bmsgc2l6ZSBmb3IgYHBrQ2h1bmtpbmdgOyB3aGVuIHNldCBmb3JjZXMgUEsgQ2h1bmtpbmcgdG8gdG8gdHJ1ZS5cclxuICogQHBhcmFtIHtBcnJheS48UmVjb3JkPnxzdHJlYW0uU3RyZWFtfFN0cmluZ30gW2lucHV0XSAtIElucHV0IHNvdXJjZSBmb3IgYnVsa2xvYWQuIEFjY2VwdHMgYXJyYXkgb2YgcmVjb3JkcywgQ1NWIHN0cmluZywgYW5kIENTViBkYXRhIGlucHV0IHN0cmVhbSBpbiBpbnNlcnQvdXBkYXRlL3Vwc2VydC9kZWxldGUvaGFyZERlbGV0ZSBvcGVyYXRpb24sIFNPUUwgc3RyaW5nIGluIHF1ZXJ5IG9wZXJhdGlvbi5cclxuICogQHBhcmFtIHtDYWxsYmFjay48QXJyYXkuPFJlY29yZFJlc3VsdD58QXJyYXkuPEJ1bGt+QmF0Y2hSZXN1bHRJbmZvPj59IFtjYWxsYmFja10gLSBDYWxsYmFjayBmdW5jdGlvblxyXG4gKiBAcmV0dXJucyB7QnVsa35CYXRjaH1cclxuICovXHJcbkJ1bGsucHJvdG90eXBlLmxvYWQgPSBmdW5jdGlvbih0eXBlLCBvcGVyYXRpb24sIG9wdGlvbnMsIGlucHV0LCBjYWxsYmFjaykge1xyXG4gIHZhciBzZWxmID0gdGhpcztcclxuICBpZiAoIXR5cGUgfHwgIW9wZXJhdGlvbikge1xyXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiSW5zdWZmaWNpZW50IGFyZ3VtZW50cy4gQXQgbGVhc3QsICd0eXBlJyBhbmQgJ29wZXJhdGlvbicgYXJlIHJlcXVpcmVkLlwiKTtcclxuICB9XHJcbiAgaWYgKCFfLmlzT2JqZWN0KG9wdGlvbnMpIHx8IG9wdGlvbnMuY29uc3RydWN0b3IgIT09IE9iamVjdCkgeyAvLyB3aGVuIG9wdGlvbnMgaXMgbm90IHBsYWluIGhhc2ggb2JqZWN0LCBpdCBpcyBvbWl0dGVkXHJcbiAgICBjYWxsYmFjayA9IGlucHV0O1xyXG4gICAgaW5wdXQgPSBvcHRpb25zO1xyXG4gICAgb3B0aW9ucyA9IG51bGw7XHJcbiAgfVxyXG4gIHZhciBqb2IgPSB0aGlzLmNyZWF0ZUpvYih0eXBlLCBvcGVyYXRpb24sIG9wdGlvbnMpO1xyXG4gIHZhciBpc0NodW5raW5nID0gb3B0aW9ucy5wa0NodW5raW5nIHx8IG9wdGlvbnMuY2h1bmtTaXplO1xyXG4gIGpvYi5vbmNlKCdlcnJvcicsIGZ1bmN0aW9uIChlcnJvcikge1xyXG4gICAgaWYgKGJhdGNoKSB7XHJcbiAgICAgIGJhdGNoLmVtaXQoJ2Vycm9yJywgZXJyb3IpOyAvLyBwYXNzIGpvYiBlcnJvciB0byBiYXRjaFxyXG4gICAgfVxyXG4gIH0pO1xyXG4gIHZhciBiYXRjaCA9IGpvYi5jcmVhdGVCYXRjaCgpO1xyXG4gIHZhciBjbGVhbnVwID0gZnVuY3Rpb24oKSB7XHJcbiAgICBiYXRjaCA9IG51bGw7XHJcbiAgICBqb2IuY2xvc2UoKTtcclxuICB9O1xyXG4gIHZhciBjbGVhbnVwT25FcnJvciA9IGZ1bmN0aW9uKGVycikge1xyXG4gICAgaWYgKGVyci5uYW1lICE9PSAnUG9sbGluZ1RpbWVvdXQnKSB7XHJcbiAgICAgIGNsZWFudXAoKTtcclxuICAgIH1cclxuICB9O1xyXG4gIGlmIChpc0NodW5raW5nKSB7XHJcbiAgICB2YXIgcmV0cmlldmVBbGwgPSBmdW5jdGlvbihiYXRjaGVzKSB7XHJcbiAgICAgIHZhciByZXN1bHRzID0gUHJvbWlzZS5hbGwoYmF0Y2hlcy5tYXAoZnVuY3Rpb24oaW5mbykge1xyXG4gICAgICAgIHJldHVybiBqb2IuYmF0Y2goaW5mby5pZCkucmV0cmlldmUoKTtcclxuICAgICAgfSkpO1xyXG4gICAgICByZXN1bHRzLnRoZW4oZnVuY3Rpb24ocmVzKSB7IFxyXG4gICAgICAgIGJhdGNoLmVtaXQoJ3Jlc3BvbnNlJywgXy5mbGF0dGVuKHJlcykpO1xyXG4gICAgICB9LCBmdW5jdGlvbihlcnIpIHsgXHJcbiAgICAgICAgc2VsZi5lbWl0KCdlcnJvcicsIGVycik7XHJcbiAgICAgIH0pO1xyXG4gICAgICByZXR1cm4gcmVzdWx0cztcclxuICAgIH07XHJcbiAgICB2YXIgcG9sbEJhdGNoZXMgPSBmdW5jdGlvbigpIHtcclxuICAgICAgam9iLmxpc3QoZnVuY3Rpb24oZXJyLCBiYXRjaGVzKSB7IFxyXG4gICAgICAgIGlmICghZXJyKSB7XHJcbiAgICAgICAgICBiYXRjaGVzID0gYmF0Y2hlcy5maWx0ZXIoZnVuY3Rpb24oaW5mbykgeyByZXR1cm4gaW5mby5pZCAhPSBiYXRjaC5pZDsgfSk7XHJcbiAgICAgICAgICB2YXIgYWxsQ29tcGxldGVkID0gYmF0Y2hlcy5ldmVyeShmdW5jdGlvbihpbmZvKSB7IHJldHVybiBpbmZvLnN0YXRlID09ICdDb21wbGV0ZWQnOyB9KTsgICAgIFxyXG4gICAgICAgICAgaWYgKGFsbENvbXBsZXRlZCkge1xyXG4gICAgICAgICAgICByZXRyaWV2ZUFsbChiYXRjaGVzKTtcclxuICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHZhciBmYWlsZWRCYXRjaCA9IGJhdGNoZXMuZmluZChmdW5jdGlvbihpbmZvKSB7IHJldHVybiBpbmZvLnN0YXRlID09ICdGYWlsZWQnOyB9KTtcclxuICAgICAgICAgICAgaWYgKGZhaWxlZEJhdGNoKSB7XHJcbiAgICAgICAgICAgICAgc2VsZi5lbWl0KCdlcnJvcicsIG5ldyBFcnJvcihmYWlsZWRCYXRjaC5zdGF0ZU1lc3NhZ2UpKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICBzZXRUaW1lb3V0KHBvbGxCYXRjaGVzLCBzZWxmLnBvbGxJbnRlcnZhbCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgc2VsZi5lbWl0KCdlcnJvcicsIGVycm9yKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0pO1xyXG4gICAgfTtcclxuICAgIHZhciBoYW5kbGVQcm9ncmVzcyA9IGZ1bmN0aW9uKHByb2dyZXNzKSB7IFxyXG4gICAgICBpZiAocHJvZ3Jlc3Muc3RhdGUgPT0gXCJOb3RQcm9jZXNzZWRcIikge1xyXG4gICAgICAgIGJhdGNoLnBvbGxTdG9wKCk7XHJcbiAgICAgICAgcG9sbEJhdGNoZXMoKTtcclxuICAgICAgfVxyXG4gICAgfTtcclxuICAgIGJhdGNoLm9uKCdwcm9ncmVzcycsIGhhbmRsZVByb2dyZXNzKTtcclxuICB9XHJcbiAgYmF0Y2gub24oJ3Jlc3BvbnNlJywgY2xlYW51cCk7XHJcbiAgYmF0Y2gub24oJ2Vycm9yJywgY2xlYW51cE9uRXJyb3IpO1xyXG4gIGJhdGNoLm9uKCdxdWV1ZScsIGZ1bmN0aW9uKCkgeyBiYXRjaC5wb2xsKHNlbGYucG9sbEludGVydmFsLCBzZWxmLnBvbGxUaW1lb3V0KTsgfSk7XHJcbiAgcmV0dXJuIGJhdGNoLmV4ZWN1dGUoaW5wdXQsIGNhbGxiYWNrKTtcclxufTtcclxuXHJcbi8qKlxyXG4gKiBFeGVjdXRlIGJ1bGsgcXVlcnkgYW5kIGdldCByZWNvcmQgc3RyZWFtXHJcbiAqXHJcbiAqIEBwYXJhbSB7U3RyaW5nfSBzb3FsIC0gU09RTCB0byBleGVjdXRlIGluIGJ1bGsgam9iXHJcbiAqIEByZXR1cm5zIHtSZWNvcmRTdHJlYW0uUGFyc2FibGV9IC0gUmVjb3JkIHN0cmVhbSwgY29udmVydGlibGUgdG8gQ1NWIGRhdGEgc3RyZWFtXHJcbiAqL1xyXG5CdWxrLnByb3RvdHlwZS5xdWVyeSA9IGZ1bmN0aW9uKHNvcWwsIG9wdGlvbnMpIHtcclxuICB2YXIgbSA9IHNvcWwucmVwbGFjZSgvXFwoW1xcc1xcU10rXFwpL2csICcnKS5tYXRjaCgvRlJPTVxccysoXFx3KykvaSk7XHJcbiAgaWYgKCFtKSB7XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJObyBzb2JqZWN0IHR5cGUgZm91bmQgaW4gcXVlcnksIG1heWJlIGNhdXNlZCBieSBpbnZhbGlkIFNPUUwuXCIpO1xyXG4gIH1cclxuICB2YXIgdHlwZSA9IG1bMV07XHJcbiAgdmFyIHNlbGYgPSB0aGlzO1xyXG4gIHZhciByZWNvcmRTdHJlYW0gPSBuZXcgUmVjb3JkU3RyZWFtLlBhcnNhYmxlKCk7XHJcbiAgdmFyIGRhdGFTdHJlYW0gPSByZWNvcmRTdHJlYW0uc3RyZWFtKCdjc3YnKTtcclxuICB0aGlzLmxvYWQodHlwZSwgXCJxdWVyeVwiLCBvcHRpb25zLCBzb3FsKS50aGVuKGZ1bmN0aW9uKHJlc3VsdHMpIHtcclxuICAgIHZhciBzdHJlYW1zID0gcmVzdWx0cy5tYXAoZnVuY3Rpb24ocmVzdWx0KSB7XHJcbiAgICAgIHZhciBqb2IgPSBzZWxmLmpvYihyZXN1bHQuam9iSWQpO1xyXG4gICAgICByZXR1cm4gZnVuY3Rpb24oKSB7IFxyXG4gICAgICAgIHJldHVybiBqb2JcclxuICAgICAgICAgIC5iYXRjaChyZXN1bHQuYmF0Y2hJZClcclxuICAgICAgICAgIC5yZXN1bHQocmVzdWx0LmlkKVxyXG4gICAgICAgICAgLnN0cmVhbSgpO1xyXG4gICAgICB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgam9pblN0cmVhbXMoc3RyZWFtcykucGlwZShkYXRhU3RyZWFtKTtcclxuICB9KS5mYWlsKGZ1bmN0aW9uKGVycikge1xyXG4gICAgcmVjb3JkU3RyZWFtLmVtaXQoJ2Vycm9yJywgZXJyKTtcclxuICB9KTtcclxuICByZXR1cm4gcmVjb3JkU3RyZWFtO1xyXG59O1xyXG5cclxuXHJcbi8qKlxyXG4gKiBDcmVhdGUgYSBuZXcgam9iIGluc3RhbmNlXHJcbiAqXHJcbiAqIEBwYXJhbSB7U3RyaW5nfSB0eXBlIC0gU09iamVjdCB0eXBlXHJcbiAqIEBwYXJhbSB7U3RyaW5nfSBvcGVyYXRpb24gLSBCdWxrIGxvYWQgb3BlcmF0aW9uICgnaW5zZXJ0JywgJ3VwZGF0ZScsICd1cHNlcnQnLCAnZGVsZXRlJywgJ2hhcmREZWxldGUnLCBvciAncXVlcnknKVxyXG4gKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIC0gT3B0aW9ucyBmb3IgYnVsayBsb2FkaW5nIG9wZXJhdGlvblxyXG4gKiBAcmV0dXJucyB7QnVsa35Kb2J9XHJcbiAqL1xyXG5CdWxrLnByb3RvdHlwZS5jcmVhdGVKb2IgPSBmdW5jdGlvbih0eXBlLCBvcGVyYXRpb24sIG9wdGlvbnMpIHtcclxuICByZXR1cm4gbmV3IEpvYih0aGlzLCB0eXBlLCBvcGVyYXRpb24sIG9wdGlvbnMpO1xyXG59O1xyXG5cclxuLyoqXHJcbiAqIEdldCBhIGpvYiBpbnN0YW5jZSBzcGVjaWZpZWQgYnkgZ2l2ZW4gam9iIElEXHJcbiAqXHJcbiAqIEBwYXJhbSB7U3RyaW5nfSBqb2JJZCAtIEpvYiBJRFxyXG4gKiBAcmV0dXJucyB7QnVsa35Kb2J9XHJcbiAqL1xyXG5CdWxrLnByb3RvdHlwZS5qb2IgPSBmdW5jdGlvbihqb2JJZCkge1xyXG4gIHJldHVybiBuZXcgSm9iKHRoaXMsIG51bGwsIG51bGwsIG51bGwsIGpvYklkKTtcclxufTtcclxuXHJcblxyXG4vKi0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tKi9cclxuLypcclxuICogUmVnaXN0ZXIgaG9vayBpbiBjb25uZWN0aW9uIGluc3RhbnRpYXRpb24gZm9yIGR5bmFtaWNhbGx5IGFkZGluZyB0aGlzIEFQSSBtb2R1bGUgZmVhdHVyZXNcclxuICovXHJcbmpzZm9yY2Uub24oJ2Nvbm5lY3Rpb246bmV3JywgZnVuY3Rpb24oY29ubikge1xyXG4gIGNvbm4uYnVsayA9IG5ldyBCdWxrKGNvbm4pO1xyXG59KTtcclxuXHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IEJ1bGs7XHJcbiIsIi8vIHNoaW0gZm9yIHVzaW5nIHByb2Nlc3MgaW4gYnJvd3NlclxudmFyIHByb2Nlc3MgPSBtb2R1bGUuZXhwb3J0cyA9IHt9O1xuXG4vLyBjYWNoZWQgZnJvbSB3aGF0ZXZlciBnbG9iYWwgaXMgcHJlc2VudCBzbyB0aGF0IHRlc3QgcnVubmVycyB0aGF0IHN0dWIgaXRcbi8vIGRvbid0IGJyZWFrIHRoaW5ncy4gIEJ1dCB3ZSBuZWVkIHRvIHdyYXAgaXQgaW4gYSB0cnkgY2F0Y2ggaW4gY2FzZSBpdCBpc1xuLy8gd3JhcHBlZCBpbiBzdHJpY3QgbW9kZSBjb2RlIHdoaWNoIGRvZXNuJ3QgZGVmaW5lIGFueSBnbG9iYWxzLiAgSXQncyBpbnNpZGUgYVxuLy8gZnVuY3Rpb24gYmVjYXVzZSB0cnkvY2F0Y2hlcyBkZW9wdGltaXplIGluIGNlcnRhaW4gZW5naW5lcy5cblxudmFyIGNhY2hlZFNldFRpbWVvdXQ7XG52YXIgY2FjaGVkQ2xlYXJUaW1lb3V0O1xuXG5mdW5jdGlvbiBkZWZhdWx0U2V0VGltb3V0KCkge1xuICAgIHRocm93IG5ldyBFcnJvcignc2V0VGltZW91dCBoYXMgbm90IGJlZW4gZGVmaW5lZCcpO1xufVxuZnVuY3Rpb24gZGVmYXVsdENsZWFyVGltZW91dCAoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdjbGVhclRpbWVvdXQgaGFzIG5vdCBiZWVuIGRlZmluZWQnKTtcbn1cbihmdW5jdGlvbiAoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKHR5cGVvZiBzZXRUaW1lb3V0ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjYWNoZWRTZXRUaW1lb3V0ID0gc2V0VGltZW91dDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNhY2hlZFNldFRpbWVvdXQgPSBkZWZhdWx0U2V0VGltb3V0O1xuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjYWNoZWRTZXRUaW1lb3V0ID0gZGVmYXVsdFNldFRpbW91dDtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKHR5cGVvZiBjbGVhclRpbWVvdXQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIGNhY2hlZENsZWFyVGltZW91dCA9IGNsZWFyVGltZW91dDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNhY2hlZENsZWFyVGltZW91dCA9IGRlZmF1bHRDbGVhclRpbWVvdXQ7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNhY2hlZENsZWFyVGltZW91dCA9IGRlZmF1bHRDbGVhclRpbWVvdXQ7XG4gICAgfVxufSAoKSlcbmZ1bmN0aW9uIHJ1blRpbWVvdXQoZnVuKSB7XG4gICAgaWYgKGNhY2hlZFNldFRpbWVvdXQgPT09IHNldFRpbWVvdXQpIHtcbiAgICAgICAgLy9ub3JtYWwgZW52aXJvbWVudHMgaW4gc2FuZSBzaXR1YXRpb25zXG4gICAgICAgIHJldHVybiBzZXRUaW1lb3V0KGZ1biwgMCk7XG4gICAgfVxuICAgIC8vIGlmIHNldFRpbWVvdXQgd2Fzbid0IGF2YWlsYWJsZSBidXQgd2FzIGxhdHRlciBkZWZpbmVkXG4gICAgaWYgKChjYWNoZWRTZXRUaW1lb3V0ID09PSBkZWZhdWx0U2V0VGltb3V0IHx8ICFjYWNoZWRTZXRUaW1lb3V0KSAmJiBzZXRUaW1lb3V0KSB7XG4gICAgICAgIGNhY2hlZFNldFRpbWVvdXQgPSBzZXRUaW1lb3V0O1xuICAgICAgICByZXR1cm4gc2V0VGltZW91dChmdW4sIDApO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgICAvLyB3aGVuIHdoZW4gc29tZWJvZHkgaGFzIHNjcmV3ZWQgd2l0aCBzZXRUaW1lb3V0IGJ1dCBubyBJLkUuIG1hZGRuZXNzXG4gICAgICAgIHJldHVybiBjYWNoZWRTZXRUaW1lb3V0KGZ1biwgMCk7XG4gICAgfSBjYXRjaChlKXtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIC8vIFdoZW4gd2UgYXJlIGluIEkuRS4gYnV0IHRoZSBzY3JpcHQgaGFzIGJlZW4gZXZhbGVkIHNvIEkuRS4gZG9lc24ndCB0cnVzdCB0aGUgZ2xvYmFsIG9iamVjdCB3aGVuIGNhbGxlZCBub3JtYWxseVxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZFNldFRpbWVvdXQuY2FsbChudWxsLCBmdW4sIDApO1xuICAgICAgICB9IGNhdGNoKGUpe1xuICAgICAgICAgICAgLy8gc2FtZSBhcyBhYm92ZSBidXQgd2hlbiBpdCdzIGEgdmVyc2lvbiBvZiBJLkUuIHRoYXQgbXVzdCBoYXZlIHRoZSBnbG9iYWwgb2JqZWN0IGZvciAndGhpcycsIGhvcGZ1bGx5IG91ciBjb250ZXh0IGNvcnJlY3Qgb3RoZXJ3aXNlIGl0IHdpbGwgdGhyb3cgYSBnbG9iYWwgZXJyb3JcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWRTZXRUaW1lb3V0LmNhbGwodGhpcywgZnVuLCAwKTtcbiAgICAgICAgfVxuICAgIH1cblxuXG59XG5mdW5jdGlvbiBydW5DbGVhclRpbWVvdXQobWFya2VyKSB7XG4gICAgaWYgKGNhY2hlZENsZWFyVGltZW91dCA9PT0gY2xlYXJUaW1lb3V0KSB7XG4gICAgICAgIC8vbm9ybWFsIGVudmlyb21lbnRzIGluIHNhbmUgc2l0dWF0aW9uc1xuICAgICAgICByZXR1cm4gY2xlYXJUaW1lb3V0KG1hcmtlcik7XG4gICAgfVxuICAgIC8vIGlmIGNsZWFyVGltZW91dCB3YXNuJ3QgYXZhaWxhYmxlIGJ1dCB3YXMgbGF0dGVyIGRlZmluZWRcbiAgICBpZiAoKGNhY2hlZENsZWFyVGltZW91dCA9PT0gZGVmYXVsdENsZWFyVGltZW91dCB8fCAhY2FjaGVkQ2xlYXJUaW1lb3V0KSAmJiBjbGVhclRpbWVvdXQpIHtcbiAgICAgICAgY2FjaGVkQ2xlYXJUaW1lb3V0ID0gY2xlYXJUaW1lb3V0O1xuICAgICAgICByZXR1cm4gY2xlYXJUaW1lb3V0KG1hcmtlcik7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIC8vIHdoZW4gd2hlbiBzb21lYm9keSBoYXMgc2NyZXdlZCB3aXRoIHNldFRpbWVvdXQgYnV0IG5vIEkuRS4gbWFkZG5lc3NcbiAgICAgICAgcmV0dXJuIGNhY2hlZENsZWFyVGltZW91dChtYXJrZXIpO1xuICAgIH0gY2F0Y2ggKGUpe1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgLy8gV2hlbiB3ZSBhcmUgaW4gSS5FLiBidXQgdGhlIHNjcmlwdCBoYXMgYmVlbiBldmFsZWQgc28gSS5FLiBkb2Vzbid0ICB0cnVzdCB0aGUgZ2xvYmFsIG9iamVjdCB3aGVuIGNhbGxlZCBub3JtYWxseVxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZENsZWFyVGltZW91dC5jYWxsKG51bGwsIG1hcmtlcik7XG4gICAgICAgIH0gY2F0Y2ggKGUpe1xuICAgICAgICAgICAgLy8gc2FtZSBhcyBhYm92ZSBidXQgd2hlbiBpdCdzIGEgdmVyc2lvbiBvZiBJLkUuIHRoYXQgbXVzdCBoYXZlIHRoZSBnbG9iYWwgb2JqZWN0IGZvciAndGhpcycsIGhvcGZ1bGx5IG91ciBjb250ZXh0IGNvcnJlY3Qgb3RoZXJ3aXNlIGl0IHdpbGwgdGhyb3cgYSBnbG9iYWwgZXJyb3IuXG4gICAgICAgICAgICAvLyBTb21lIHZlcnNpb25zIG9mIEkuRS4gaGF2ZSBkaWZmZXJlbnQgcnVsZXMgZm9yIGNsZWFyVGltZW91dCB2cyBzZXRUaW1lb3V0XG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkQ2xlYXJUaW1lb3V0LmNhbGwodGhpcywgbWFya2VyKTtcbiAgICAgICAgfVxuICAgIH1cblxuXG5cbn1cbnZhciBxdWV1ZSA9IFtdO1xudmFyIGRyYWluaW5nID0gZmFsc2U7XG52YXIgY3VycmVudFF1ZXVlO1xudmFyIHF1ZXVlSW5kZXggPSAtMTtcblxuZnVuY3Rpb24gY2xlYW5VcE5leHRUaWNrKCkge1xuICAgIGlmICghZHJhaW5pbmcgfHwgIWN1cnJlbnRRdWV1ZSkge1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGRyYWluaW5nID0gZmFsc2U7XG4gICAgaWYgKGN1cnJlbnRRdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgcXVldWUgPSBjdXJyZW50UXVldWUuY29uY2F0KHF1ZXVlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBxdWV1ZUluZGV4ID0gLTE7XG4gICAgfVxuICAgIGlmIChxdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgZHJhaW5RdWV1ZSgpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gZHJhaW5RdWV1ZSgpIHtcbiAgICBpZiAoZHJhaW5pbmcpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2YXIgdGltZW91dCA9IHJ1blRpbWVvdXQoY2xlYW5VcE5leHRUaWNrKTtcbiAgICBkcmFpbmluZyA9IHRydWU7XG5cbiAgICB2YXIgbGVuID0gcXVldWUubGVuZ3RoO1xuICAgIHdoaWxlKGxlbikge1xuICAgICAgICBjdXJyZW50UXVldWUgPSBxdWV1ZTtcbiAgICAgICAgcXVldWUgPSBbXTtcbiAgICAgICAgd2hpbGUgKCsrcXVldWVJbmRleCA8IGxlbikge1xuICAgICAgICAgICAgaWYgKGN1cnJlbnRRdWV1ZSkge1xuICAgICAgICAgICAgICAgIGN1cnJlbnRRdWV1ZVtxdWV1ZUluZGV4XS5ydW4oKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBxdWV1ZUluZGV4ID0gLTE7XG4gICAgICAgIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB9XG4gICAgY3VycmVudFF1ZXVlID0gbnVsbDtcbiAgICBkcmFpbmluZyA9IGZhbHNlO1xuICAgIHJ1bkNsZWFyVGltZW91dCh0aW1lb3V0KTtcbn1cblxucHJvY2Vzcy5uZXh0VGljayA9IGZ1bmN0aW9uIChmdW4pIHtcbiAgICB2YXIgYXJncyA9IG5ldyBBcnJheShhcmd1bWVudHMubGVuZ3RoIC0gMSk7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAxKSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAxOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBhcmdzW2kgLSAxXSA9IGFyZ3VtZW50c1tpXTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBxdWV1ZS5wdXNoKG5ldyBJdGVtKGZ1biwgYXJncykpO1xuICAgIGlmIChxdWV1ZS5sZW5ndGggPT09IDEgJiYgIWRyYWluaW5nKSB7XG4gICAgICAgIHJ1blRpbWVvdXQoZHJhaW5RdWV1ZSk7XG4gICAgfVxufTtcblxuLy8gdjggbGlrZXMgcHJlZGljdGlibGUgb2JqZWN0c1xuZnVuY3Rpb24gSXRlbShmdW4sIGFycmF5KSB7XG4gICAgdGhpcy5mdW4gPSBmdW47XG4gICAgdGhpcy5hcnJheSA9IGFycmF5O1xufVxuSXRlbS5wcm90b3R5cGUucnVuID0gZnVuY3Rpb24gKCkge1xuICAgIHRoaXMuZnVuLmFwcGx5KG51bGwsIHRoaXMuYXJyYXkpO1xufTtcbnByb2Nlc3MudGl0bGUgPSAnYnJvd3Nlcic7XG5wcm9jZXNzLmJyb3dzZXIgPSB0cnVlO1xucHJvY2Vzcy5lbnYgPSB7fTtcbnByb2Nlc3MuYXJndiA9IFtdO1xucHJvY2Vzcy52ZXJzaW9uID0gJyc7IC8vIGVtcHR5IHN0cmluZyB0byBhdm9pZCByZWdleHAgaXNzdWVzXG5wcm9jZXNzLnZlcnNpb25zID0ge307XG5cbmZ1bmN0aW9uIG5vb3AoKSB7fVxuXG5wcm9jZXNzLm9uID0gbm9vcDtcbnByb2Nlc3MuYWRkTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5vbmNlID0gbm9vcDtcbnByb2Nlc3Mub2ZmID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5yZW1vdmVBbGxMaXN0ZW5lcnMgPSBub29wO1xucHJvY2Vzcy5lbWl0ID0gbm9vcDtcbnByb2Nlc3MucHJlcGVuZExpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3MucHJlcGVuZE9uY2VMaXN0ZW5lciA9IG5vb3A7XG5cbnByb2Nlc3MubGlzdGVuZXJzID0gZnVuY3Rpb24gKG5hbWUpIHsgcmV0dXJuIFtdIH1cblxucHJvY2Vzcy5iaW5kaW5nID0gZnVuY3Rpb24gKG5hbWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuYmluZGluZyBpcyBub3Qgc3VwcG9ydGVkJyk7XG59O1xuXG5wcm9jZXNzLmN3ZCA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICcvJyB9O1xucHJvY2Vzcy5jaGRpciA9IGZ1bmN0aW9uIChkaXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuY2hkaXIgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcbnByb2Nlc3MudW1hc2sgPSBmdW5jdGlvbigpIHsgcmV0dXJuIDA7IH07XG4iXX0=

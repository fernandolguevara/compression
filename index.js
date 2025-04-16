/*!
 * compression
 * Copyright(c) 2010 Sencha Inc.
 * Copyright(c) 2011 TJ Holowaychuk
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict'

/**
 * Module dependencies.
 * @private
 */

var Negotiator = require('negotiator')
var bytes = require('bytes')
var compressible = require('compressible')
var debug = require('debug')('compression')
var onHeaders = require('on-headers')
var vary = require('vary')
var zlib = require('zlib')
var ServerResponse = require('http').ServerResponse

/**
 * Module exports.
 */

module.exports = compression
module.exports.filter = shouldCompress

/**
 * Module variables.
 * @private
 */
var cacheControlNoTransformRegExp = /(?:^|,)\s*?no-transform\s*?(?:,|$)/

var SUPPORTED_ENCODING = ['br', 'gzip', 'deflate', 'identity']
var PREFERRED_ENCODING = ['br', 'gzip']

var encodingSupported = ['gzip', 'deflate', 'identity', 'br']

/**
 * Compress response data with gzip / deflate.
 *
 * @param {Object} [options]
 * @return {Function} middleware
 * @public
 */

function compression (options) {
  var opts = options || {}
  var optsBrotli = {
    ...opts.brotli,
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 4, // set the default level to a reasonable value with balanced speed/ratio
      ...opts.brotli?.params
    }
  }

  // options
  var filter = opts.filter || shouldCompress
  var threshold = bytes.parse(opts.threshold)
  var enforceEncoding = opts.enforceEncoding || 'identity'

  if (threshold == null) {
    threshold = 1024
  }

  function noop () { }

  return function compression (req, res, next) {
    var ended = false
    var length
    var listeners = []
    var stream

    var _end = res.end
    var _on = res.on
    var _write = res.write

    // flush
    res.flush = function flush () {
      if (stream) {
        stream.flush()
      }
    }

    // proxy

    res.write = function write (chunk, encoding, callback) {
      if (chunk === null) {
        // throw ERR_STREAM_NULL_VALUES
        return _write.call(this, chunk, encoding, callback)
      } else if (typeof chunk === 'string' || typeof chunk.fill === 'function' || isUint8Array(chunk)) {
        // noop
      } else {
        // throw ERR_INVALID_ARG_TYPE
        return _write.call(this, chunk, encoding, callback)
      }

      if (!callback && typeof encoding === 'function') {
        callback = encoding
        encoding = undefined
      }

      if (typeof callback !== 'function') {
        callback = noop
      }

      if (res.destroyed || res.finished || ended) {
        // HACK: node doesn't expose internal errors,
        // we need to fake response to throw underlying errors type
        var fakeRes = new ServerResponse({})
        fakeRes.on('error', function (err) {
          res.emit('error', err)
        })
        fakeRes.destroyed = res.destroyed
        fakeRes.finished = res.finished || ended
        // throw ERR_STREAM_DESTROYED or ERR_STREAM_WRITE_AFTER_END
        _write.call(fakeRes, chunk, encoding, callback)
        return false
      }

      if (!res.headersSent) {
        this.writeHead(this.statusCode)
      }

      if (chunk) {
        chunk = toBuffer(chunk, encoding)
      }

      return stream
        ? stream.write(chunk, encoding, callback)
        : _write.call(this, chunk, encoding, callback)
    }

    res.end = function end (chunk, encoding, callback) {
      if (!callback) {
        if (typeof chunk === 'function') {
          callback = chunk
          chunk = encoding = undefined
        } else if (typeof encoding === 'function') {
          callback = encoding
          encoding = undefined
        }
      }

      if (typeof callback !== 'function') {
        callback = noop
      }

      if (this.destroyed || this.finished || ended) {
        this.finished = ended
        // throw ERR_STREAM_WRITE_AFTER_END or ERR_STREAM_ALREADY_FINISHED
        return _end.call(this, chunk, encoding, callback)
      }

      if (!res.headersSent) {
        // estimate the length
        if (!this.getHeader('Content-Length')) {
          length = chunkLength(chunk, encoding)
        }

        this.writeHead(this.statusCode)
      }

      if (!stream) {
        return _end.call(this, chunk, encoding, callback)
      }

      // mark ended
      ended = true

      if (chunk) {
        chunk = toBuffer(chunk, encoding)
      }

      // write Buffer for Node.js 0.8
      return chunk
        ? stream.end(chunk, encoding, callback)
        : stream.end(chunk, callback)
    }

    res.on = function on (type, listener) {
      if (!listeners || type !== 'drain') {
        return _on.call(this, type, listener)
      }

      if (stream) {
        return stream.on(type, listener)
      }

      // buffer listeners for future stream
      listeners.push([type, listener])

      return this
    }

    function nocompress (msg) {
      debug('no compression: %s', msg)
      addListeners(res, _on, listeners)
      listeners = null
    }

    onHeaders(res, function onResponseHeaders () {
      // determine if request is filtered
      if (!filter(req, res)) {
        nocompress('filtered')
        return
      }

      // determine if the entity should be transformed
      if (!shouldTransform(req, res)) {
        nocompress('no transform')
        return
      }

      // vary
      vary(res, 'Accept-Encoding')

      // content-length below threshold
      if (Number(res.getHeader('Content-Length')) < threshold || length < threshold) {
        nocompress('size below threshold')
        return
      }

      var encoding = res.getHeader('Content-Encoding') || 'identity'

      // already encoded
      if (encoding !== 'identity') {
        nocompress('already encoded')
        return
      }

      // head
      if (req.method === 'HEAD') {
        nocompress('HEAD request')
        return
      }

      // compression method
      var negotiator = new Negotiator(req)
      var method = negotiator.encoding(SUPPORTED_ENCODING, PREFERRED_ENCODING)

      // if no method is found, use the default encoding
      if (!req.headers['accept-encoding'] && encodingSupported.indexOf(enforceEncoding) !== -1) {
        method = enforceEncoding
      }

      // negotiation failed
      if (!method || method === 'identity') {
        nocompress('not acceptable')
        return
      }

      // compression stream
      debug('%s compression', method)
      stream = method === 'gzip'
        ? zlib.createGzip(opts)
        : method === 'br'
          ? zlib.createBrotliCompress(optsBrotli)
          : zlib.createDeflate(opts)

      // add buffered listeners to stream
      addListeners(stream, stream.on, listeners)

      // header fields
      res.setHeader('Content-Encoding', method)
      res.removeHeader('Content-Length')

      // compression
      stream.on('error', function (err) {
        res.emit('error', err)
      })

      stream.on('data', function onStreamData (chunk) {
        if (_write.call(res, chunk) === false) {
          stream.pause()
        }
      })

      stream.on('end', function onStreamEnd () {
        _end.call(res)
      })

      _on.call(res, 'drain', function onResponseDrain () {
        stream.resume()
      })
    })

    next()
  }
}

/**
 * Add bufferred listeners to stream
 * @private
 */

function addListeners (stream, on, listeners) {
  for (var i = 0; i < listeners.length; i++) {
    on.apply(stream, listeners[i])
  }
}

/**
 * Get the length of a given chunk
 */

function chunkLength (chunk, encoding) {
  if (!chunk) {
    return 0
  }

  return Buffer.isBuffer(chunk)
    ? chunk.length
    : Buffer.byteLength(chunk, encoding)
}

/**
 * Default filter function.
 * @private
 */

function shouldCompress (req, res) {
  var type = res.getHeader('Content-Type')

  if (type === undefined || !compressible(type)) {
    debug('%s not compressible', type)
    return false
  }

  return true
}

/**
 * Determine if the entity should be transformed.
 * @private
 */

function shouldTransform (req, res) {
  var cacheControl = res.getHeader('Cache-Control')

  // Don't compress for Cache-Control: no-transform
  // https://tools.ietf.org/html/rfc7234#section-5.2.2.4
  return !cacheControl ||
    !cacheControlNoTransformRegExp.test(cacheControl)
}

/**
 * Coerce arguments to Buffer
 * @private
 */

function toBuffer (chunk, encoding) {
  return Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk, encoding)
}

/**
 * Checks if the given argument is an instance of Uint8Array.
 *
 * @param {*} arg - The value to check.
 * @returns {boolean} Returns `true` if the argument is an instance of Uint8Array, otherwise `false`.
 * @private
 */
function isUint8Array (arg) {
  return arg && arg instanceof Uint8Array
}
#!/usr/bin/env node
'use strict';

process.env.UV_THREADPOOL_SIZE =
    Math.ceil(Math.max(4, require('os').cpus().length * 1.5));

var fs = require('fs'),
    path = require('path');

var clone = require('clone'),
    cors = require('cors'),
    enableShutdown = require('http-shutdown'),
    express = require('express'),
    handlebars = require('handlebars'),
    mercator = new (require('@mapbox/sphericalmercator'))(),
    morgan = require('morgan');

var packageJson = require('../package'),
    serve_font = require('./serve_font'),
    serve_rendered = null,
    serve_style = require('./serve_style'),
    serve_mbtiles = require('./serve_mbtiles'),
    utils = require('./utils');

var isLight = packageJson.name.slice(-6) == '-light';
if (!isLight) {
  // do not require `serve_rendered` in the light package
  serve_rendered = require('./serve_rendered');
}

function start(opts) {
  console.log('Starting server');

  var app = express().disable('x-powered-by'),
      serving = {
        gl-styles: {},
        rendered: {},
        mbtiles: {},
        fonts: {}
      };

  app.enable('trust proxy');

  if (process.env.NODE_ENV == 'production') {
    app.use(morgan('tiny', {
      skip: function(req, res) { return opts.silent && (res.statusCode == 200 || res.statusCode == 304) }
    }));
  } else if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('dev', {
      skip: function(req, res) { return opts.silent && (res.statusCode == 200 || res.statusCode == 304) }
    }));
  }

  var config = opts.config || null;
  var configPath = null;
  if (opts.configPath) {
    configPath = path.resolve(opts.configPath);
    try {
      config = clone(require(configPath));
    } catch (e) {
      console.log('ERROR: Config file not found or invalid!');
      console.log('       See README.md for instructions and sample mbtiles.');
      process.exit(1);
    }
  }
  if (!config) {
    console.log('ERROR: No config file not specified!');
    process.exit(1);
  }

  var options = config.options || {};
  var paths = options.paths || {};
  options.paths = paths;
  paths.root = path.resolve(
    configPath ? path.dirname(configPath) : process.cwd(),
    paths.root || '');
  paths.gl-styles = path.resolve(paths.root, paths.gl-styles || '');
  paths.fonts = path.resolve(paths.root, paths.fonts || '');
  paths.sprites = path.resolve(paths.root, paths.sprites || '');
  paths.mbtiles = path.resolve(paths.root, paths.mbtiles || '');

  var startupPromises = [];

  var checkPath = function(type) {
    if (!fs.existsSync(paths[type])) {
      console.error('The specified path for "' + type + '" does not exist (' + paths[type] + ').');
      process.exit(1);
    }
  };
  checkPath('gl-styles');
  checkPath('fonts');
  checkPath('sprites');
  checkPath('mbtiles');

  if (options.mbtilesDecorator) {
    try {
      options.mbtilesDecoratorFunc = require(path.resolve(paths.root, options.mbtilesDecorator));
    } catch (e) {}
  }

  var mbtiles = clone(config.mbtiles || {});

  if (opts.cors) {
    app.use(cors());
  }

  Object.keys(config.gl-styles || {}).forEach(function(id) {
    var item = config.gl-styles[id];
    if (!item.style || item.style.length == 0) {
      console.log('Missing "style" property for ' + id);
      return;
    }

    if (item.serve_mbtiles !== false) {
      startupPromises.push(serve_style(options, serving.gl-styles, item, id,
        function(mbtiles, fromData) {
          var mbtilesItemId;
          Object.keys(mbtiles).forEach(function(id) {
            if (fromData) {
              if (id == mbtiles) {
                mbtilesItemId = id;
              }
            } else {
              if (mbtiles[id].mbtiles == mbtiles) {
                mbtilesItemId = id;
              }
            }
          });
          if (mbtilesItemId) { // mbtiles exist in the mbtiles config
            return mbtilesItemId;
          } else if (fromData) {
            console.log('ERROR: mbtiles "' + mbtiles + '" not found!');
            process.exit(1);
          } else {
            var id = mbtiles.substr(0, mbtiles.lastIndexOf('.')) || mbtiles;
            while (mbtiles[id]) id += '_';
            mbtiles[id] = {
              'mbtiles': mbtiles
            };
            return id;
          }
        }, function(font) {
          serving.fonts[font] = true;
        }).then(function(sub) {
          app.use('/gl-styles/', sub);
        }));
    }
    if (item.serve_rendered !== false) {
      if (serve_rendered) {
        startupPromises.push(
          serve_rendered(options, serving.rendered, item, id,
            function(mbtiles) {
              var mbtilesFile;
              Object.keys(mbtiles).forEach(function(id) {
                if (id == mbtiles) {
                  mbtilesFile = mbtiles[id].mbtiles;
                }
              });
              return mbtilesFile;
            }
          ).then(function(sub) {
            app.use('/gl-styles/', sub);
          })
        );
      } else {
        item.serve_rendered = false;
      }
    }
  });

  startupPromises.push(
    serve_font(options, serving.fonts).then(function(sub) {
      app.use('/', sub);
    })
  );

  Object.keys(mbtiles).forEach(function(id) {
    var item = mbtiles[id];
    if (!item.mbtiles || item.mbtiles.length == 0) {
      console.log('Missing "mbtiles" property for ' + id);
      return;
    }

    startupPromises.push(
      serve_mbtiles(options, serving.mbtiles, item, id, serving.gl-styles).then(function(sub) {
        app.use('/mbtiles/', sub);
      })
    );
  });

  app.get('/gl-styles.json', function(req, res, next) {
    var result = [];
    var query = req.query.key ? ('?key=' + req.query.key) : '';
    Object.keys(serving.gl-styles).forEach(function(id) {
      var styleJSON = serving.gl-styles[id];
      result.push({
        version: styleJSON.version,
        name: styleJSON.name,
        id: id,
        url: req.protocol + '://' + req.headers.host +
             '/gl-styles/' + id + '/style.json' + query
      });
    });
    res.send(result);
  });

  var addTileJSONs = function(arr, req, type) {
    Object.keys(serving[type]).forEach(function(id) {
      var info = clone(serving[type][id]);
      var path = '';
      if (type == 'rendered') {
        path = 'gl-styles/' + id;
      } else {
        path = type + '/' + id;
      }
      info.tiles = utils.getTileUrls(req, info.tiles, path, info.format, {
        'pbf': options.pbfAlias
      });
      arr.push(info);
    });
    return arr;
  };

  app.get('/rendered.json', function(req, res, next) {
    res.send(addTileJSONs([], req, 'rendered'));
  });
  app.get('/mbtiles.json', function(req, res, next) {
    res.send(addTileJSONs([], req, 'mbtiles'));
  });
  app.get('/index.json', function(req, res, next) {
    res.send(addTileJSONs(addTileJSONs([], req, 'rendered'), req, 'mbtiles'));
  });

  //------------------------------------
  // serve web presentations
  app.use('/', express.static(path.join(__dirname, '../public/resources')));

  var templates = path.join(__dirname, '../public/templates');
  var serveTemplate = function(urlPath, template, mbtilesGetter) {
    var templateFile = templates + '/' + template + '.tmpl';
    if (template == 'index') {
      if (options.frontPage === false) {
        return;
      } else if (options.frontPage &&
                 options.frontPage.constructor === String) {
        templateFile = path.resolve(paths.root, options.frontPage);
      }
    }
    startupPromises.push(new Promise(function(resolve, reject) {
      fs.readFile(templateFile, function(err, content) {
        if (err) {
          err = new Error('Template not found: ' + err.message);
          reject(err);
          return;
        }
        var compiled = handlebars.compile(content.toString());

        app.use(urlPath, function(req, res, next) {
          var mbtiles = {};
          if (mbtilesGetter) {
            mbtiles = mbtilesGetter(req);
            if (!mbtiles) {
              return res.status(404).send('Not found');
            }
          }
          mbtiles['server_version'] = packageJson.name + ' v' + packageJson.version;
          mbtiles['is_light'] = isLight;
          mbtiles['key_query_part'] =
              req.query.key ? 'key=' + req.query.key + '&amp;' : '';
          mbtiles['key_query'] = req.query.key ? '?key=' + req.query.key : '';
          if (template === 'wmts') res.set('Content-Type', 'text/xml');
          return res.status(200).send(compiled(mbtiles));
        });
        resolve();
      });
    }));
  };

  serveTemplate('/$', 'index', function(req) {
    var gl-styles = clone(config.gl-styles || {});
    Object.keys(gl-styles).forEach(function(id) {
      var style = gl-styles[id];
      style.name = (serving.gl-styles[id] || serving.rendered[id] || {}).name;
      style.serving_mbtiles = serving.gl-styles[id];
      style.serving_rendered = serving.rendered[id];
      if (style.serving_rendered) {
        var center = style.serving_rendered.center;
        if (center) {
          style.viewer_hash = '#' + center[2] + '/' +
                              center[1].toFixed(5) + '/' +
                              center[0].toFixed(5);

          var centerPx = mercator.px([center[0], center[1]], center[2]);
          style.thumbnail = center[2] + '/' +
              Math.floor(centerPx[0] / 256) + '/' +
              Math.floor(centerPx[1] / 256) + '.png';
        }
        
        var tiles = utils.getTileUrls(
            req, style.serving_rendered.tiles,
            'gl-styles/' + id, style.serving_rendered.format);
        style.xyz_link = tiles[0];
      }
    });
    var mbtiles = clone(serving.mbtiles || {});
    Object.keys(mbtiles).forEach(function(id) {
      var mbtiles_ = mbtiles[id];
      var center = mbtiles_.center;
      if (center) {
        mbtiles_.viewer_hash = '#' + center[2] + '/' +
                            center[1].toFixed(5) + '/' +
                            center[0].toFixed(5);
      }
      mbtiles_.is_vector = mbtiles_.format == 'pbf';
      if (!mbtiles_.is_vector) {
        if (center) {
          var centerPx = mercator.px([center[0], center[1]], center[2]);
          mbtiles_.thumbnail = center[2] + '/' +
              Math.floor(centerPx[0] / 256) + '/' +
              Math.floor(centerPx[1] / 256) + '.' + mbtiles_.format;
        }

        var tiles = utils.getTileUrls(
            req, mbtiles_.tiles, 'mbtiles/' + id, mbtiles_.format, {
              'pbf': options.pbfAlias
            });
        mbtiles_.xyz_link = tiles[0];
      }
      if (mbtiles_.filesize) {
        var suffix = 'kB';
        var size = parseInt(mbtiles_.filesize, 10) / 1024;
        if (size > 1024) {
          suffix = 'MB';
          size /= 1024;
        }
        if (size > 1024) {
          suffix = 'GB';
          size /= 1024;
        }
        mbtiles_.formatted_filesize = size.toFixed(2) + ' ' + suffix;
      }
    });
    return {
      gl-styles: Object.keys(gl-styles).length ? gl-styles : null,
      mbtiles: Object.keys(mbtiles).length ? mbtiles : null
    };
  });

  serveTemplate('/gl-styles/:id/$', 'viewer', function(req) {
    var id = req.params.id;
    var style = clone((config.gl-styles || {})[id]);
    if (!style) {
      return null;
    }
    style.id = id;
    style.name = (serving.gl-styles[id] || serving.rendered[id]).name;
    style.serving_mbtiles = serving.gl-styles[id];
    style.serving_rendered = serving.rendered[id];
    return style;
  });

  /*
  app.use('/rendered/:id/$', function(req, res, next) {
    return res.redirect(301, '/gl-styles/' + req.params.id + '/');
  });
  */
  serveTemplate('/gl-styles/:id/wmts.xml', 'wmts', function(req) {
    var id = req.params.id;
    var wmts = clone((config.gl-styles || {})[id]);
    if (!wmts) {
      return null;
    }
    if (wmts.hasOwnProperty("serve_rendered") && !wmts.serve_rendered) {
      return null;
    }
    wmts.id = id;
    wmts.name = (serving.gl-styles[id] || serving.rendered[id]).name;
    wmts.baseUrl = (req.get('X-Forwarded-Protocol')?req.get('X-Forwarded-Protocol'):req.protocol) + '://' + req.get('host');
    return wmts;
  });

  serveTemplate('/mbtiles/:id/$', 'mbtiles', function(req) {
    var id = req.params.id;
    var mbtiles = clone(serving.mbtiles[id]);
    if (!mbtiles) {
      return null;
    }
    mbtiles.id = id;
    mbtiles.is_vector = mbtiles.format == 'pbf';
    return mbtiles;
  });

  var startupComplete = false;
  var startupPromise = Promise.all(startupPromises).then(function() {
    console.log('Startup complete');
    startupComplete = true;
  });
  app.get('/health', function(req, res, next) {
    if (startupComplete) {
      return res.status(200).send('OK');
    } else {
      return res.status(503).send('Starting');
    }
  });

  var server = app.listen(process.env.PORT || opts.port, process.env.BIND || opts.bind, function() {
    var address = this.address().address;
    if (address.indexOf('::') === 0) {
      address = '[' + address + ']'; // literal IPv6 address
    }
    console.log('Listening at http://%s:%d/', address, this.address().port);
  });

  // add server.shutdown() to gracefully stop serving
  enableShutdown(server);

  return {
    app: app,
    server: server,
    startupPromise: startupPromise
  };
}

module.exports = function(opts) {
  var running = start(opts);

  running.startupPromise.catch(function(err) {
    console.error(err.message);
    process.exit(1);
  });

  process.on('SIGINT', function() {
    process.exit();
  });

  process.on('SIGHUP', function() {
    console.log('Stopping server and reloading config');

    running.server.shutdown(function() {
      for (var key in require.cache) {
        delete require.cache[key];
      }

      var restarted = start(opts);
      running.server = restarted.server;
      running.app = restarted.app;
    });
  });

  return running;
};

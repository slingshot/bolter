const crypto = require('crypto');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const uaparser = require('ua-parser-js');
const storage = require('../storage');
const config = require('../config');
const auth = require('../middleware/auth');
const language = require('../middleware/language');
const pages = require('./pages');
const filelist = require('./filelist');
const clientConstants = require('../clientConstants');

const IS_DEV = config.env === 'development';
const ID_REGEX = '([0-9a-fA-F]{10,16})';

module.exports = function(app) {
  app.set('trust proxy', true);
  app.use(helmet());
  app.use(
    helmet.hsts({
      maxAge: 31536000,
      force: !IS_DEV
    })
  );
  app.use(function(req, res, next) {
    req.ua = uaparser(req.header('user-agent'));
    next();
  });
  app.use(function(req, res, next) {
    req.cspNonce = crypto.randomBytes(16).toString('hex');
    next();
  });
  if (!IS_DEV) {
    let csp = {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: [
          "'self'",
          function(req) {
            const baseUrl = config.deriveBaseUrl(req);
            const r = baseUrl.replace(/^http(s?):\/\//, 'ws$1://');
            console.log([baseUrl, r]);
            return r;
          },
          // Allow connections to S3/R2 endpoints for direct downloads
          config.s3_endpoint || 'https://*.amazonaws.com',
          'https://*.r2.cloudflarestorage.com'
        ],
        imgSrc: ["'self'", 'data:'],
        scriptSrc: [
          "'self'",
          function(req) {
            return `'nonce-${req.cspNonce}'`;
          }
        ],
        styleSrc: [
          "'self'",
          function(req) {
            return `'nonce-${req.cspNonce}'`;
          }
        ],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        reportUri: '/__cspreport__'
      }
    };

    app.use(helmet.contentSecurityPolicy(csp));
  }

  app.use(function(req, res, next) {
    res.set('Pragma', 'no-cache');
    res.set(
      'Cache-Control',
      'private, no-cache, no-store, must-revalidate, max-age=0'
    );
    next();
  });
  app.use(function(req, res, next) {
    try {
      // set by the load balancer
      const [country, state] = req.header('X-Client-Geo-Location').split(',');
      req.geo = {
        country,
        state
      };
    } catch (e) {
      req.geo = {};
    }
    next();
  });
  app.use(bodyParser.json());
  app.use(bodyParser.text());
  app.get('/', language, pages.index);
  app.get('/config', function(req, res) {
    res.json(clientConstants);
  });
  app.get('/error', language, pages.blank);
  app.get('/oauth', language, pages.blank);
  app.get('/login', language, pages.index);
  app.get('/app.webmanifest', language, require('./webmanifest'));
  app.get(`/download/:id${ID_REGEX}`, language, pages.download);
  app.get('/unsupported/:reason', language, pages.unsupported);
  app.get(
    `/api/download/:id${ID_REGEX}`,
    auth.conditionalHmac,
    require('./download')
  );
  app.get(
    `/api/download/blob/:id${ID_REGEX}`,
    auth.conditionalHmac,
    require('./download')
  );
  app.get(`/api/exists/:id${ID_REGEX}`, require('./exists'));
  app.get(
    `/api/metadata/:id${ID_REGEX}`,
    auth.conditionalHmac,
    require('./metadata')
  );
  app.get(
    `/api/download/url/:id${ID_REGEX}`,
    auth.conditionalHmac,
    require('./downloadUrl')
  );
  app.post(
    `/api/download/complete/:id${ID_REGEX}`,
    auth.conditionalHmac,
    require('./downloadComplete')
  );
  app.get('/api/filelist/:id([\\w-]{16})', auth.fxa, filelist.get);
  app.post('/api/filelist/:id([\\w-]{16})', auth.fxa, filelist.post);
  app.post('/api/upload', auth.fxa, require('./upload'));
  app.post('/api/upload/url', auth.fxa, require('./uploadUrl'));
  app.post('/api/upload/complete', auth.fxa, require('./uploadComplete'));
  app.post(
    `/api/upload/abort/:id${ID_REGEX}`,
    auth.fxa,
    require('./uploadAbort')
  );
  app.post(`/api/delete/:id${ID_REGEX}`, auth.owner, require('./delete'));
  app.post(`/api/password/:id${ID_REGEX}`, auth.owner, require('./password'));
  app.post(
    `/api/params/:id${ID_REGEX}`,
    auth.owner,
    auth.fxa,
    require('./params')
  );
  app.post(`/api/info/:id${ID_REGEX}`, auth.owner, require('./info'));
  app.get('/__version__', function(req, res) {
    // eslint-disable-next-line node/no-missing-require
    res.sendFile(require.resolve('../../dist/version.json'));
  });

  app.get('/__lbheartbeat__', function(req, res) {
    res.sendStatus(200);
  });

  app.get('/__heartbeat__', async (req, res) => {
    try {
      await storage.ping();
      res.sendStatus(200);
    } catch (e) {
      res.sendStatus(500);
    }
  });
};

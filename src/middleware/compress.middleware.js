const zlib = require('zlib');

const MIN_BYTES = 1024;

/**
 * Gzips JSON responses for clients that accept it (no extra dependency). The
 * vehicles list is the biggest response and shrinks by roughly 85%, which is what
 * matters most on mobile data.
 */
function compressJson(req, res, next) {
  const accepts = String(req.headers['accept-encoding'] || '');
  if (!/\bgzip\b/.test(accepts)) return next();

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const text = JSON.stringify(body);
    if (text.length < MIN_BYTES) {
      res.type('application/json');
      return res.send(text);
    }
    zlib.gzip(text, (err, compressed) => {
      if (err) {
        res.type('application/json');
        return res.send(text);
      }
      res.set({ 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      res.type('application/json');
      res.send(compressed);
    });
    return res;
  };
  next();
}

module.exports = compressJson;

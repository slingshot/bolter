const storage = require('../storage');

module.exports = async function(req, res) {
  const id = req.params.id;
  const meta = req.meta;
  console.log(
    'DEBUG: /api/metadata route - meta object:',
    JSON.stringify(meta, null, 2)
  );
  try {
    const ttl = await storage.ttl(id);
    const response = {
      metadata: meta.metadata,
      finalDownload: meta.dl + 1 === +meta.dlimit,
      ttl,
      encrypted: meta.encrypted !== 'false'
    };
    console.log(
      'DEBUG: /api/metadata route - response:',
      JSON.stringify(response, null, 2)
    );
    res.send(response);
  } catch (e) {
    console.log('DEBUG: /api/metadata route - error:', e);
    res.sendStatus(404);
  }
};

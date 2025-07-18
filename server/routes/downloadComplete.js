const storage = require('../storage');
const mozlog = require('../log');
const log = mozlog('send.downloadComplete');

module.exports = async function(req, res) {
  const id = req.params.id;
  try {
    const meta = req.meta;
    const dl = meta.dl + 1;
    const dlimit = +meta.dlimit;

    if (dl >= dlimit) {
      await storage.del(id);
      log.info('fileDeleted', { id });
    } else {
      await storage.incrementField(id, 'dl');
      log.info('downloadIncremented', { id, dl });
    }

    res.json({ success: true, downloadCount: dl });
  } catch (e) {
    log.error('downloadCompleteError', e);
    res.sendStatus(404);
  }
};

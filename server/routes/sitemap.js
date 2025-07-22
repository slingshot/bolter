const config = require('../config');

module.exports = async function(req, res) {
  const baseUrl = config.deriveBaseUrl(req);

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;

  res.set('Content-Type', 'application/xml');
  res.send(sitemap);
};

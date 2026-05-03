const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  const plistPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Info.plist');
  try {
    let plist = fs.readFileSync(plistPath, 'utf8');
    plist = plist
      .replace(/<key>LSUIElement<\/key>\s*<true\/>/g, '<key>LSUIElement</key>\n  <false/>')
      .replace(/<key>LSBackgroundOnly<\/key>\s*<true\/>/g, '<key>LSBackgroundOnly</key>\n  <false/>');
    if (!plist.includes('<key>LSUIElement</key>')) {
      plist = plist.replace('</dict>', '  <key>LSUIElement</key>\n  <false/>\n</dict>');
    }
    if (!plist.includes('<key>LSBackgroundOnly</key>')) {
      plist = plist.replace('</dict>', '  <key>LSBackgroundOnly</key>\n  <false/>\n</dict>');
    }
    fs.writeFileSync(plistPath, plist);
  } catch {}
};

// Decoders for the Discogs responses the settings page reads. Each checks the response once,
// where it arrives, and fails with a reason instead of letting a malformed reply become an empty list.

const isText = (v) => v === String(v);

// GET users/{username}/collection/folders → the folder names.
function decodeFolderNames(json) {
  const folders = json?.folders;
  if (!Array.isArray(folders)) throw new Error("Discogs sent a folder list in an unexpected form");
  return folders.map((f, i) => {
    if (!isText(f?.name)) throw new Error(`Discogs sent folder ${i + 1} without a name`);
    return f.name;
  });
}

// GET oauth/identity → the username the token belongs to.
function decodeIdentity(json) {
  const name = json?.username;
  if (!isText(name) || !name) throw new Error("Discogs didn't say which account the token belongs to");
  return name;
}

module.exports = { decodeFolderNames, decodeIdentity };

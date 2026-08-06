function createSessionCredentialCache(platform = process.platform) {
  let cached = null;

  return {
    decrypt(encryptedValue, decryptValue) {
      if (!encryptedValue) return '';
      if (platform === 'darwin' && cached?.encryptedValue === encryptedValue) return cached.plaintext;
      const plaintext = decryptValue(encryptedValue);
      if (platform === 'darwin' && plaintext) cached = { encryptedValue, plaintext };
      return plaintext;
    },

    remember(encryptedValue, plaintext) {
      if (platform === 'darwin' && encryptedValue && plaintext) cached = { encryptedValue, plaintext };
    },

    clear() {
      cached = null;
    }
  };
}

module.exports = { createSessionCredentialCache };

import Nanobus from 'nanobus';
import OwnedFile from './ownedFile';
import Keychain from './keychain';
import { arrayToB64, bytes } from './utils';
import { uploadDirect } from './api';
import { encryptedSize } from './utils';

export default class FileSender extends Nanobus {
  constructor() {
    super('FileSender');
    this.keychain = new Keychain();
    this.reset();
  }

  get progressRatio() {
    return this.progress[0] / this.progress[1];
  }

  get progressIndefinite() {
    return (
      [
        'fileSizeProgress',
        'notifyUploadEncryptDone',
        'notifyUploadDone'
      ].indexOf(this.msg) === -1
    );
  }

  get sizes() {
    return {
      partialSize: bytes(this.progress[0]),
      totalSize: bytes(this.progress[1])
    };
  }

  reset() {
    this.uploadRequest = null;
    this.msg = 'importingFile';
    this.progress = [0, 1];
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
    if (this.uploadRequest) {
      this.uploadRequest.cancel();
    }
  }

  async upload(archive, bearerToken) {
    if (this.cancelled) {
      throw new Error(0);
    }

    let encStream, metadata, authKeyB64, totalSize;

    if (archive.encrypted) {
      this.msg = 'encryptingFile';
      this.emit('encrypting');
      totalSize = encryptedSize(archive.size);
      encStream = await this.keychain.encryptStream(archive.stream);
      metadata = await this.keychain.encryptMetadata(archive);
      authKeyB64 = await this.keychain.authKeyB64();
    } else {
      this.msg = 'importingFile';
      this.emit('importing');
      totalSize = archive.size;
      encStream = archive.stream;
      metadata = btoa(
        unescape(encodeURIComponent(JSON.stringify(archive.manifest)))
      );
      authKeyB64 = 'unencrypted';
    }

    // Try direct upload first, fall back to WebSocket
    this.uploadRequest = uploadDirect(
      encStream,
      metadata,
      authKeyB64,
      archive.timeLimit,
      archive.dlimit,
      bearerToken,
      totalSize,
      p => {
        this.progress = [p, totalSize];
        this.emit('progress');
      },
      archive.encrypted
    );

    if (this.cancelled) {
      throw new Error(0);
    }

    this.msg = 'fileSizeProgress';
    this.emit('progress'); // HACK to kick MS Edge
    try {
      const result = await this.uploadRequest.result;
      this.msg = archive.encrypted
        ? 'notifyUploadEncryptDone'
        : 'notifyUploadDone';
      this.uploadRequest = null;
      this.progress = [1, 1];
      const secretKey = archive.encrypted
        ? arrayToB64(this.keychain.rawSecret)
        : null;
      const ownedFile = new OwnedFile({
        id: result.id,
        url: archive.encrypted
          ? `${result.url.split('#')[0]}#${secretKey}`
          : result.url,
        name: archive.name,
        size: archive.size,
        manifest: archive.manifest,
        time: result.duration,
        speed: archive.size / (result.duration / 1000),
        createdAt: Date.now(),
        expiresAt: Date.now() + archive.timeLimit * 1000,
        secretKey: secretKey,
        nonce: archive.encrypted ? this.keychain.nonce : null,
        ownerToken: result.ownerToken,
        dlimit: archive.dlimit,
        timeLimit: archive.timeLimit,
        encrypted: archive.encrypted
      });

      return ownedFile;
    } catch (e) {
      this.msg = 'errorPageHeader';
      this.uploadRequest = null;

      // Log error details for debugging
      console.error('Upload failed in FileSender:', {
        fileName: archive.name,
        fileSize: archive.size,
        encrypted: archive.encrypted,
        timeLimit: archive.timeLimit,
        error: e.message
      });

      throw e;
    }
  }
}

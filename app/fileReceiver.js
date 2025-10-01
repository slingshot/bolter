import Nanobus from 'nanobus';
import Keychain from './keychain';
import { delay, bytes, streamToArrayBuffer } from './utils';
import { downloadFile, metadata, getApiUrl, reportLink } from './api';
import { blobStream } from './streams';
import Zip from './zip';

export default class FileReceiver extends Nanobus {
  constructor(fileInfo) {
    super('FileReceiver');
    this.keychain = fileInfo.secretKey
      ? new Keychain(fileInfo.secretKey, fileInfo.nonce)
      : null;
    if (fileInfo.requiresPassword && this.keychain) {
      this.keychain.setPassword(fileInfo.password, fileInfo.url);
    }
    this.fileInfo = fileInfo;
    this.reset();
  }

  get progressRatio() {
    return this.progress[0] / this.progress[1];
  }

  get progressIndefinite() {
    return this.state !== 'downloading';
  }

  get sizes() {
    return {
      partialSize: bytes(this.progress[0]),
      totalSize: bytes(this.progress[1])
    };
  }

  cancel() {
    if (this.downloadRequest) {
      this.downloadRequest.cancel();
    }
  }

  reset() {
    this.msg = 'fileSizeProgress';
    this.state = 'initialized';
    this.progress = [0, 1];
  }

  async getMetadata() {
    console.log('DEBUG: getMetadata called with:', {
      fileId: this.fileInfo.id,
      hasKeychain: !!this.keychain,
      fileInfoEncrypted: this.fileInfo.encrypted,
      fileInfoSecretKey: this.fileInfo.secretKey ? 'present' : 'missing',
      fileInfoNonce: this.fileInfo.nonce ? 'present' : 'missing'
    });

    const meta = await metadata(this.fileInfo.id, this.keychain);

    console.log('DEBUG: metadata response:', {
      metaName: meta.name,
      metaSize: meta.size,
      metaEncrypted: meta.encrypted,
      metaTtl: meta.ttl,
      metaIv: meta.iv ? 'present' : 'missing',
      metaManifest: meta.manifest ? 'present' : 'missing'
    });

    this.fileInfo.name = meta.name;
    this.fileInfo.type = meta.type;
    this.fileInfo.iv = meta.iv;
    this.fileInfo.size = +meta.size;
    this.fileInfo.manifest = meta.manifest;
    this.fileInfo.encrypted = meta.encrypted;

    // If file is unencrypted but we have a keychain, remove it
    if (!meta.encrypted && this.keychain) {
      console.log('DEBUG: Removing keychain for unencrypted file');
      this.keychain = null;
    }

    console.log('DEBUG: Final fileInfo state:', {
      name: this.fileInfo.name,
      size: this.fileInfo.size,
      encrypted: this.fileInfo.encrypted,
      hasKeychain: !!this.keychain
    });

    this.state = 'ready';
  }

  async reportLink(reason) {
    await reportLink(this.fileInfo.id, this.keychain, reason);
  }

  sendMessageToSw(msg) {
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();

      channel.port1.onmessage = function(event) {
        if (event.data === undefined) {
          reject('bad response from serviceWorker');
        } else if (event.data.error !== undefined) {
          reject(event.data.error);
        } else {
          resolve(event.data);
        }
      };

      navigator.serviceWorker.controller.postMessage(msg, [channel.port2]);
    });
  }

  async downloadBlob(noSave = false) {
    this.state = 'downloading';
    this.downloadRequest = await downloadFile(
      this.fileInfo.id,
      this.keychain,
      p => {
        this.progress = [p, this.fileInfo.size];
        this.emit('progress');
      }
    );
    try {
      const ciphertext = await this.downloadRequest.result;
      this.downloadRequest = null;

      let plainStream;
      let size = this.fileInfo.size;

      if (this.fileInfo.encrypted !== false && this.keychain) {
        this.msg = 'decryptingFile';
        this.state = 'decrypting';
        this.emit('decrypting');
        plainStream = this.keychain.decryptStream(blobStream(ciphertext));
      } else {
        // File is not encrypted
        plainStream = blobStream(ciphertext);
      }

      if (this.fileInfo.type === 'send-archive') {
        const zip = new Zip(this.fileInfo.manifest, plainStream);
        plainStream = zip.stream;
        size = zip.size;
      }

      const plaintext = await streamToArrayBuffer(plainStream, size);
      if (!noSave) {
        await saveFile({
          plaintext,
          name: decodeURIComponent(this.fileInfo.name),
          type: this.fileInfo.type
        });
      }
      this.msg = 'downloadFinish';
      this.emit('complete');
      this.state = 'complete';
    } catch (e) {
      this.downloadRequest = null;
      throw e;
    }
  }

  async downloadDirect() {
    // For unencrypted files, get signed URL and download directly
    this.state = 'downloading';

    try {
      const response = await fetch(
        getApiUrl(`/api/download/url/${this.fileInfo.id}`),
        {
          method: 'GET'
        }
      );

      if (!response.ok) {
        throw new Error('Failed to get download URL');
      }

      const urlData = await response.json();

      if (urlData.useSignedUrl) {
        // Mark as complete immediately (before triggering download)
        // This ensures Safari shows the success page even if the download mechanism has issues
        this.msg = 'downloadFinish';
        this.state = 'complete';
        this.emit('complete');

        // Small delay to ensure UI updates before download triggers
        await new Promise(resolve => setTimeout(resolve, 100));

        // Create a temporary link element with the signed URL
        const a = document.createElement('a');
        a.href = urlData.url;

        // The download attribute is optional since S3 presigned URL
        // includes ResponseContentDisposition header with filename
        // But we'll still set it as a fallback
        const fileName = decodeURIComponent(this.fileInfo.name);
        a.download = fileName;

        // Safari-specific handling
        if (/^((?!chrome|android).)*safari/i.test(navigator.userAgent)) {
          // For Safari, use window.open as fallback
          try {
            // Try the standard approach first
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          } catch (e) {
            // Fallback to window.open for Safari
            window.open(urlData.url, '_blank');
          }
        } else {
          // Standard approach for other browsers
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }

        // Report download completion after a delay (to avoid premature deletion)
        // This gives the browser time to start the download
        setTimeout(async () => {
          try {
            await fetch(
              getApiUrl(`/api/download/complete/${this.fileInfo.id}`),
              {
                method: 'POST'
              }
            );
          } catch (e) {
            // Ignore errors in completion reporting
            console.warn('Failed to report download completion:', e);
          }
        }, 2000);
      } else {
        // Fallback to blob download if no signed URL is available
        return this.downloadBlob();
      }
    } catch (e) {
      this.state = 'error';
      throw e;
    }
  }

  async downloadStream(noSave = false) {
    const start = Date.now();
    const onprogress = p => {
      this.progress = [p, this.fileInfo.size];
      this.emit('progress');
    };

    this.downloadRequest = {
      cancel: () => {
        this.sendMessageToSw({ request: 'cancel', id: this.fileInfo.id });
      }
    };

    try {
      this.state = 'downloading';

      const info = {
        request: 'init',
        id: this.fileInfo.id,
        filename: this.fileInfo.name,
        type: this.fileInfo.type,
        manifest: this.fileInfo.manifest,
        key: this.fileInfo.secretKey,
        requiresPassword: this.fileInfo.requiresPassword,
        password: this.fileInfo.password,
        url: this.fileInfo.url,
        size: this.fileInfo.size,
        nonce: this.keychain ? this.keychain.nonce : null,
        noSave
      };
      await this.sendMessageToSw(info);

      onprogress(0);

      if (noSave) {
        const res = await fetch(getApiUrl(`/api/download/${this.fileInfo.id}`));
        if (res.status !== 200) {
          throw new Error(res.status);
        }
      } else {
        const downloadPath = `/api/download/${this.fileInfo.id}`;
        let downloadUrl = getApiUrl(downloadPath);
        if (downloadUrl === downloadPath) {
          downloadUrl = `${location.protocol}//${location.host}${downloadPath}`;
        }
        const a = document.createElement('a');
        a.href = downloadUrl;
        document.body.appendChild(a);
        a.click();
      }

      let prog = 0;
      let hangs = 0;
      while (prog < this.fileInfo.size) {
        const msg = await this.sendMessageToSw({
          request: 'progress',
          id: this.fileInfo.id
        });
        if (msg.progress === prog) {
          hangs++;
        } else {
          hangs = 0;
        }
        if (hangs > 30) {
          // TODO: On Chrome we don't get a cancel
          // signal so one is indistinguishable from
          // a hang. We may be able to detect
          // which end is hung in the service worker
          // to improve on this.
          const e = new Error('hung download');
          e.duration = Date.now() - start;
          e.size = this.fileInfo.size;
          e.progress = prog;
          throw e;
        }
        prog = msg.progress;
        onprogress(prog);
        await delay(1000);
      }

      this.downloadRequest = null;
      this.msg = 'downloadFinish';
      this.emit('complete');
      this.state = 'complete';
    } catch (e) {
      this.downloadRequest = null;
      if (e === 'cancelled' || e.message === '400') {
        throw new Error(0);
      }
      throw e;
    }
  }

  download(options) {
    // For unencrypted files, use direct download (unless noSave is true)
    // Archives (send-archive type) are already zipped on the server, so direct download works
    if (!this.fileInfo.encrypted && !options.noSave) {
      return this.downloadDirect();
    }
    // For encrypted files or when noSave is true, use existing methods
    if (options.stream) {
      return this.downloadStream(options.noSave);
    }
    return this.downloadBlob(options.noSave);
  }
}

async function saveFile(file) {
  return new Promise(function(resolve, reject) {
    const dataView = new DataView(file.plaintext);
    const blob = new Blob([dataView], { type: file.type });

    if (navigator.msSaveBlob) {
      navigator.msSaveBlob(blob, file.name);
      return resolve();
    } else {
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      URL.revokeObjectURL(downloadUrl);
      setTimeout(resolve, 100);
    }
  });
}

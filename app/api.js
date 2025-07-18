import { arrayToB64, b64ToArray, delay, streamToArrayBuffer } from './utils';
import { ECE_RECORD_SIZE } from './ece';

let fileProtocolWssUrl = null;
try {
  fileProtocolWssUrl = localStorage.getItem('wssURL');
} catch (e) {
  // NOOP
}
if (!fileProtocolWssUrl) {
  fileProtocolWssUrl = 'wss://send.firefox.com/api/ws';
}

export class ConnectionError extends Error {
  constructor(cancelled, duration, size) {
    super(cancelled ? '0' : 'connection closed');
    this.cancelled = cancelled;
    this.duration = duration;
    this.size = size;
  }
}

export function setFileProtocolWssUrl(url) {
  localStorage && localStorage.setItem('wssURL', url);
  fileProtocolWssUrl = url;
}

export function getFileProtocolWssUrl() {
  return fileProtocolWssUrl;
}

let apiUrlPrefix = '';
export function getApiUrl(path) {
  return apiUrlPrefix + path;
}

export function setApiUrlPrefix(prefix) {
  apiUrlPrefix = prefix;
}

function post(obj, bearerToken) {
  const h = {
    'Content-Type': 'application/json'
  };
  if (bearerToken) {
    h['Authorization'] = `Bearer ${bearerToken}`;
  }
  return {
    method: 'POST',
    headers: new Headers(h),
    body: JSON.stringify(obj)
  };
}

export function parseNonce(header) {
  header = header || '';
  return header.split(' ')[1];
}

async function fetchWithAuth(url, params, keychain) {
  const result = {};
  params = params || {};
  const h = await keychain.authHeader();
  params.headers = new Headers({
    Authorization: h,
    'Content-Type': 'application/json'
  });
  const response = await fetch(url, params);
  result.response = response;
  result.ok = response.ok;
  const nonce = parseNonce(response.headers.get('WWW-Authenticate'));
  result.shouldRetry = response.status === 401 && nonce !== keychain.nonce;
  keychain.nonce = nonce;
  return result;
}

async function fetchWithAuthAndRetry(url, params, keychain) {
  const result = await fetchWithAuth(url, params, keychain);
  if (result.shouldRetry) {
    return fetchWithAuth(url, params, keychain);
  }
  return result;
}

export async function del(id, owner_token) {
  const response = await fetch(
    getApiUrl(`/api/delete/${id}`),
    post({ owner_token })
  );
  return response.ok;
}

export async function setParams(id, owner_token, bearerToken, params) {
  const response = await fetch(
    getApiUrl(`/api/params/${id}`),
    post(
      {
        owner_token,
        dlimit: params.dlimit
      },
      bearerToken
    )
  );
  return response.ok;
}

export async function fileInfo(id, owner_token) {
  const response = await fetch(
    getApiUrl(`/api/info/${id}`),
    post({ owner_token })
  );

  if (response.ok) {
    const obj = await response.json();
    return obj;
  }

  throw new Error(response.status);
}

export async function metadata(id, keychain) {
  console.log('DEBUG: metadata API called with:', {
    id: id,
    hasKeychain: !!keychain,
    keychainNonce: keychain ? keychain.nonce : null
  });

  let result;
  if (keychain) {
    console.log('DEBUG: Making authenticated request to /api/metadata/' + id);
    result = await fetchWithAuthAndRetry(
      getApiUrl(`/api/metadata/${id}`),
      { method: 'GET' },
      keychain
    );
  } else {
    console.log('DEBUG: Making unauthenticated request to /api/metadata/' + id);
    // For unencrypted files, make a simple GET request without auth
    const response = await fetch(getApiUrl(`/api/metadata/${id}`), {
      method: 'GET'
    });
    result = { response, ok: response.ok };
  }

  console.log(
    'DEBUG: metadata API response status:',
    result.response.status,
    'ok:',
    result.ok
  );

  if (result.ok) {
    const data = await result.response.json();
    console.log('DEBUG: API metadata data:', JSON.stringify(data, null, 2));
    let meta;
    if (data.encrypted !== false && keychain) {
      console.log('DEBUG: Decrypting metadata with keychain');
      meta = await keychain.decryptMetadata(b64ToArray(data.metadata));
    } else {
      console.log('DEBUG: Decoding unencrypted metadata');
      // For unencrypted files, metadata is base64 encoded JSON
      console.log(
        'DEBUG: Raw metadata before decode:',
        JSON.stringify(data.metadata)
      );
      try {
        // Try Unicode-safe decoding first (for new uploads)
        meta = JSON.parse(decodeURIComponent(escape(atob(data.metadata))));
        console.log('DEBUG: Used Unicode-safe decoding');
      } catch (e) {
        console.log(
          'DEBUG: Unicode-safe decoding failed, using simple atob:',
          e.message
        );
        // Fall back to simple atob for old uploads
        meta = JSON.parse(atob(data.metadata));
        console.log('DEBUG: Simple atob decoding succeeded');
      }
      console.log('DEBUG: Parsed metadata:', JSON.stringify(meta, null, 2));
    }

    // Handle different metadata structures
    let processedMeta;
    if (meta.files && meta.files.length > 0) {
      // New format: metadata contains files array directly
      if (meta.files.length > 1) {
        // Multiple files - use zip metadata
        const totalSize = meta.files.reduce(
          (total, file) => total + file.size,
          0
        );
        processedMeta = {
          name: 'Send-Archive.zip',
          size: totalSize,
          type: 'send-archive',
          iv: meta.iv,
          manifest: meta
        };
      } else {
        // Single file
        const firstFile = meta.files[0];
        processedMeta = {
          name: firstFile.name,
          size: firstFile.size,
          type: firstFile.type,
          iv: meta.iv,
          manifest: meta
        };
      }
    } else {
      // Old format: metadata contains individual file info
      processedMeta = {
        name: meta.name,
        size: meta.size,
        type: meta.type,
        iv: meta.iv,
        manifest: meta.manifest || {
          files: [{ name: meta.name, size: meta.size, type: meta.type }]
        }
      };
    }

    const result_meta = {
      size: processedMeta.size,
      ttl: data.ttl,
      iv: processedMeta.iv,
      name: processedMeta.name,
      type: processedMeta.type,
      manifest: processedMeta.manifest,
      encrypted: data.encrypted !== false
    };
    console.log('Final metadata result:', JSON.stringify(result_meta, null, 2));
    return result_meta;
  }
  throw new Error(result.response.status);
}

export async function setPassword(id, owner_token, keychain) {
  const auth = await keychain.authKeyB64();
  const response = await fetch(
    getApiUrl(`/api/password/${id}`),
    post({ owner_token, auth })
  );
  return response.ok;
}

function asyncInitWebSocket(server) {
  return new Promise((resolve, reject) => {
    try {
      const ws = new WebSocket(server);
      ws.addEventListener('open', () => resolve(ws), { once: true });
    } catch (e) {
      reject(new ConnectionError(false));
    }
  });
}

function listenForResponse(ws, canceller) {
  return new Promise((resolve, reject) => {
    function handleClose(event) {
      // a 'close' event before a 'message' event means the request failed
      ws.removeEventListener('message', handleMessage);
      reject(new ConnectionError(canceller.cancelled));
    }
    function handleMessage(msg) {
      ws.removeEventListener('close', handleClose);
      try {
        const response = JSON.parse(msg.data);
        if (response.error) {
          throw new Error(response.error);
        } else {
          resolve(response);
        }
      } catch (e) {
        reject(e);
      }
    }
    ws.addEventListener('message', handleMessage, { once: true });
    ws.addEventListener('close', handleClose, { once: true });
  });
}

async function upload(
  stream,
  metadata,
  verifierB64,
  timeLimit,
  dlimit,
  bearerToken,
  onprogress,
  canceller,
  isEncrypted = true
) {
  let size = 0;
  const start = Date.now();
  const host = window.location.hostname;
  const port = window.location.port;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const endpoint =
    window.location.protocol === 'file:'
      ? fileProtocolWssUrl
      : `${protocol}//${host}${port ? ':' : ''}${port}/api/ws`;

  const ws = await asyncInitWebSocket(endpoint);

  try {
    const metadataHeader = isEncrypted
      ? arrayToB64(new Uint8Array(metadata))
      : btoa(unescape(encodeURIComponent(metadata)));
    const fileMeta = {
      fileMetadata: metadataHeader,
      authorization: `send-v1 ${verifierB64}`,
      bearer: bearerToken,
      timeLimit,
      dlimit,
      encrypted: isEncrypted
    };
    const uploadInfoResponse = listenForResponse(ws, canceller);
    ws.send(JSON.stringify(fileMeta));
    const uploadInfo = await uploadInfoResponse;

    const completedResponse = listenForResponse(ws, canceller);

    const reader = stream.getReader();
    let state = await reader.read();
    while (!state.done) {
      if (canceller.cancelled) {
        ws.close();
      }
      if (ws.readyState !== WebSocket.OPEN) {
        break;
      }
      const buf = state.value;
      ws.send(buf);
      onprogress(size);
      size += buf.length;
      state = await reader.read();
      while (
        ws.bufferedAmount > ECE_RECORD_SIZE * 2 &&
        ws.readyState === WebSocket.OPEN &&
        !canceller.cancelled
      ) {
        await delay();
      }
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(new Uint8Array([0])); //EOF
    }

    await completedResponse;
    uploadInfo.duration = Date.now() - start;
    return uploadInfo;
  } catch (e) {
    e.size = size;
    e.duration = Date.now() - start;
    throw e;
  } finally {
    if (![WebSocket.CLOSED, WebSocket.CLOSING].includes(ws.readyState)) {
      ws.close();
    }
  }
}

export function uploadWs(
  encrypted,
  metadata,
  verifierB64,
  timeLimit,
  dlimit,
  bearerToken,
  onprogress,
  isEncrypted = true
) {
  const canceller = { cancelled: false };

  return {
    cancel: function() {
      canceller.cancelled = true;
    },

    result: upload(
      encrypted,
      metadata,
      verifierB64,
      timeLimit,
      dlimit,
      bearerToken,
      onprogress,
      canceller,
      isEncrypted
    )
  };
}

export function uploadDirect(
  encrypted,
  metadata,
  verifierB64,
  timeLimit,
  dlimit,
  bearerToken,
  totalSize,
  onprogress,
  isEncrypted = true
) {
  const canceller = { cancelled: false };

  return {
    cancel: function() {
      canceller.cancelled = true;
    },

    result: uploadDirectToS3(
      encrypted,
      metadata,
      verifierB64,
      timeLimit,
      dlimit,
      bearerToken,
      totalSize,
      onprogress,
      canceller,
      isEncrypted
    )
  };
}

////////////////////////

async function uploadDirectToS3(
  encrypted,
  metadata,
  verifierB64,
  timeLimit,
  dlimit,
  bearerToken,
  totalSize,
  onprogress,
  canceller,
  isEncrypted = true
) {
  const start = Date.now();

  try {
    // First, get upload URLs
    const uploadResponse = await fetch(getApiUrl('/api/upload/url'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`
      },
      body: JSON.stringify({
        fileSize: totalSize,
        encrypted: isEncrypted,
        timeLimit,
        dlimit
      })
    });

    if (!uploadResponse.ok) {
      throw new Error(`HTTP ${uploadResponse.status}`);
    }

    const uploadInfo = await uploadResponse.json();

    // Check if we should use pre-signed URLs
    if (!uploadInfo.useSignedUrl) {
      // Fall back to WebSocket upload
      return upload(
        encrypted,
        metadata,
        verifierB64,
        timeLimit,
        dlimit,
        bearerToken,
        onprogress,
        canceller,
        isEncrypted
      );
    }

    // Convert stream to blob for direct upload
    let fileBlob;
    if (encrypted.getReader) {
      // It's a ReadableStream, convert to blob
      const arrayBuffer = await streamToArrayBuffer(encrypted, totalSize);
      fileBlob = new Blob([arrayBuffer]);
    } else {
      // It's already a blob/file
      fileBlob = encrypted;
    }

    let uploadResult;

    if (uploadInfo.multipart) {
      // Multipart upload
      uploadResult = await uploadMultipart(
        fileBlob,
        uploadInfo,
        onprogress,
        canceller
      );
    } else {
      // Single part upload
      uploadResult = await uploadSinglePart(
        fileBlob,
        uploadInfo.url,
        onprogress,
        canceller
      );
    }

    if (canceller.cancelled) {
      if (uploadInfo.multipart) {
        // Abort multipart upload
        await abortMultipartUpload(
          uploadInfo.id,
          uploadInfo.uploadId,
          bearerToken
        );
      }
      throw new Error('Upload cancelled');
    }

    // Complete the upload
    // Convert metadata to string format for JSON transmission
    const metadataString = isEncrypted
      ? arrayToB64(new Uint8Array(metadata))
      : metadata; // For unencrypted, metadata is already a base64 string

    console.log('DEBUG: uploadDirectToS3 - metadata before complete:', {
      metadataType: typeof metadata,
      metadataStringType: typeof metadataString,
      metadataString: metadataString,
      isEncrypted: isEncrypted
    });

    const completeResponse = await fetch(getApiUrl('/api/upload/complete'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`
      },
      body: JSON.stringify({
        id: uploadInfo.id,
        metadata: metadataString,
        ...(isEncrypted && { authKey: verifierB64 }),
        actualSize: totalSize,
        ...(uploadInfo.multipart && { parts: uploadResult.parts })
      })
    });

    if (!completeResponse.ok) {
      throw new Error(`HTTP ${completeResponse.status}`);
    }

    const completeInfo = await completeResponse.json();

    return {
      id: uploadInfo.id,
      url: uploadInfo.completeUrl || completeInfo.url,
      ownerToken: uploadInfo.owner,
      duration: Date.now() - start
    };
  } catch (e) {
    if (canceller.cancelled) {
      throw new Error('Upload cancelled');
    }
    throw e;
  }
}

async function uploadSinglePart(file, url, onprogress, canceller) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    canceller.cancel = () => {
      xhr.abort();
    };

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) {
        onprogress(e.loaded);
      }
    });

    xhr.addEventListener('loadend', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ success: true });
      } else {
        reject(new Error(`HTTP ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => {
      reject(new Error('Network error'));
    });

    xhr.open('PUT', url);
    xhr.send(file);
  });
}

async function uploadMultipart(file, uploadInfo, onprogress, canceller) {
  const { parts, partSize } = uploadInfo;
  const completedParts = [];
  let totalUploaded = 0;

  // Upload parts in parallel (limit concurrency)
  const CONCURRENT_UPLOADS = 3;
  const uploadPromises = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const start = (part.partNumber - 1) * partSize;
    const end = Math.min(start + partSize, file.size);
    const partBlob = file.slice(start, end);

    const uploadPromise = uploadPart(
      partBlob,
      part.url,
      part.partNumber,
      loaded => {
        totalUploaded += loaded;
        onprogress(totalUploaded);
      },
      canceller
    );

    uploadPromises.push(uploadPromise);

    // Limit concurrent uploads
    if (uploadPromises.length >= CONCURRENT_UPLOADS) {
      const completed = await Promise.all(uploadPromises);
      completedParts.push(...completed);
      uploadPromises.length = 0;
    }
  }

  // Upload remaining parts
  if (uploadPromises.length > 0) {
    const completed = await Promise.all(uploadPromises);
    completedParts.push(...completed);
  }

  return {
    parts: completedParts.sort((a, b) => a.PartNumber - b.PartNumber)
  };
}

async function uploadPart(partBlob, url, partNumber, onProgress, canceller) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    const originalCancel = canceller.cancel;
    canceller.cancel = () => {
      xhr.abort();
      if (originalCancel) originalCancel();
    };

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) {
        onProgress(e.loaded);
      }
    });

    xhr.addEventListener('loadend', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag');
        resolve({
          PartNumber: partNumber,
          ETag: etag
        });
      } else {
        reject(new Error(`HTTP ${xhr.status} for part ${partNumber}`));
      }
    });

    xhr.addEventListener('error', () => {
      reject(new Error(`Network error for part ${partNumber}`));
    });

    xhr.open('PUT', url);
    xhr.send(partBlob);
  });
}

async function abortMultipartUpload(id, uploadId, bearerToken) {
  try {
    await fetch(getApiUrl(`/api/upload/abort/${id}`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`
      },
      body: JSON.stringify({ uploadId })
    });
  } catch (e) {
    console.warn('Failed to abort multipart upload:', e);
  }
}

////////////////////////

async function downloadS(id, keychain, signal) {
  const headers = {};
  if (keychain) {
    const auth = await keychain.authHeader();
    headers.Authorization = auth;
  }

  // First try to get a pre-signed URL
  const urlResponse = await fetch(getApiUrl(`/api/download/url/${id}`), {
    signal: signal,
    method: 'GET',
    headers: headers
  });

  const authHeader = urlResponse.headers.get('WWW-Authenticate');
  if (authHeader && keychain) {
    keychain.nonce = parseNonce(authHeader);
  }

  if (urlResponse.status !== 200) {
    throw new Error(urlResponse.status);
  }

  const urlData = await urlResponse.json();

  if (urlData.useSignedUrl) {
    // Use pre-signed URL for direct download
    const response = await fetch(urlData.url, {
      signal: signal,
      method: 'GET'
    });

    if (response.status !== 200) {
      throw new Error(response.status);
    }

    // Store download info for completion callback
    const body = response.body;
    body.downloadInfo = {
      id: id,
      keychain: keychain,
      dl: urlData.dl,
      dlimit: urlData.dlimit
    };

    return body;
  } else {
    // Fall back to streaming through server
    const response = await fetch(getApiUrl(`/api/download/${id}`), {
      signal: signal,
      method: 'GET',
      headers: headers
    });

    if (response.status !== 200) {
      throw new Error(response.status);
    }

    return response.body;
  }
}

async function tryDownloadStream(id, keychain, signal, tries = 2) {
  try {
    const result = await downloadS(id, keychain, signal);

    // If we used a pre-signed URL, we need to report completion
    if (result.downloadInfo) {
      const { downloadInfo } = result;
      try {
        let auth = null;
        if (downloadInfo.keychain) {
          auth = await downloadInfo.keychain.authHeader();
        }

        await fetch(getApiUrl(`/api/download/complete/${downloadInfo.id}`), {
          method: 'POST',
          headers: auth ? { Authorization: auth } : {}
        });
      } catch (e) {
        console.warn('Failed to report download completion:', e);
      }
    }

    return result;
  } catch (e) {
    if (e.message === '401' && --tries > 0) {
      return tryDownloadStream(id, keychain, signal, tries);
    }
    if (e.name === 'AbortError') {
      throw new Error('0');
    }
    throw e;
  }
}

export function downloadStream(id, keychain) {
  const controller = new AbortController();
  function cancel() {
    controller.abort();
  }
  return {
    cancel,
    result: tryDownloadStream(id, keychain, controller.signal)
  };
}

//////////////////

async function download(id, keychain, onprogress, canceller) {
  let auth = null;
  if (keychain) {
    auth = await keychain.authHeader();
  }

  // First try to get a pre-signed URL
  try {
    const urlResponse = await fetch(getApiUrl(`/api/download/url/${id}`), {
      method: 'GET',
      headers: auth ? { Authorization: auth } : {}
    });

    if (urlResponse.ok) {
      const urlData = await urlResponse.json();

      if (urlData.useSignedUrl) {
        // Use pre-signed URL for direct download
        return new Promise(function(resolve, reject) {
          const xhr = new XMLHttpRequest();
          canceller.oncancel = function() {
            xhr.abort();
          };

          xhr.addEventListener('loadend', async function() {
            canceller.oncancel = function() {};
            if (xhr.status !== 200) {
              return reject(new Error(xhr.status));
            }

            const blob = new Blob([xhr.response]);

            // Call completion endpoint
            try {
              await fetch(getApiUrl(`/api/download/complete/${id}`), {
                method: 'POST',
                headers: auth ? { Authorization: auth } : {}
              });
            } catch (e) {
              console.warn('Failed to report download completion:', e);
            }

            resolve(blob);
          });

          xhr.addEventListener('progress', function(event) {
            if (event.target.status === 200) {
              onprogress(event.loaded);
            }
          });

          xhr.open('get', urlData.url);
          xhr.responseType = 'blob';
          xhr.send();
          onprogress(0);
        });
      }
    }
  } catch (e) {
    console.warn('Failed to get pre-signed URL, falling back to streaming:', e);
  }

  // Fall back to streaming through server
  const xhr = new XMLHttpRequest();
  canceller.oncancel = function() {
    xhr.abort();
  };
  return new Promise(function(resolve, reject) {
    xhr.addEventListener('loadend', function() {
      canceller.oncancel = function() {};
      const authHeader = xhr.getResponseHeader('WWW-Authenticate');
      if (authHeader && keychain) {
        keychain.nonce = parseNonce(authHeader);
      }
      if (xhr.status !== 200) {
        return reject(new Error(xhr.status));
      }

      const blob = new Blob([xhr.response]);
      resolve(blob);
    });

    xhr.addEventListener('progress', function(event) {
      if (event.target.status === 200) {
        onprogress(event.loaded);
      }
    });
    xhr.open('get', getApiUrl(`/api/download/blob/${id}`));

    if (auth) {
      xhr.setRequestHeader('Authorization', auth);
    }

    xhr.responseType = 'blob';
    xhr.send();
    onprogress(0);
  });
}

async function tryDownload(id, keychain, onprogress, canceller, tries = 2) {
  try {
    const result = await download(id, keychain, onprogress, canceller);
    return result;
  } catch (e) {
    if (e.message === '401' && --tries > 0) {
      return tryDownload(id, keychain, onprogress, canceller, tries);
    }
    throw e;
  }
}

export function downloadFile(id, keychain, onprogress) {
  const canceller = {
    oncancel: function() {} // download() sets this
  };
  function cancel() {
    canceller.oncancel();
  }
  return {
    cancel,
    result: tryDownload(id, keychain, onprogress, canceller)
  };
}

export async function getFileList(bearerToken, kid) {
  const headers = new Headers({ Authorization: `Bearer ${bearerToken}` });
  const response = await fetch(getApiUrl(`/api/filelist/${kid}`), { headers });
  if (response.ok) {
    const encrypted = await response.blob();
    return encrypted;
  }
  throw new Error(response.status);
}

export async function setFileList(bearerToken, kid, data) {
  const headers = new Headers({ Authorization: `Bearer ${bearerToken}` });
  const response = await fetch(getApiUrl(`/api/filelist/${kid}`), {
    headers,
    method: 'POST',
    body: data
  });
  return response.ok;
}

export async function getConstants() {
  const response = await fetch(getApiUrl('/config'));

  if (response.ok) {
    const obj = await response.json();
    return obj;
  }

  throw new Error(response.status);
}

export async function reportLink(_id, _keychain, _reason) {
  // Placeholder function - implement if needed
  return Promise.resolve();
}

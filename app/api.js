import { arrayToB64, b64ToArray, delay } from './utils';
import { ECE_RECORD_SIZE } from './ece';

// Retry configuration for multipart uploads
const MAX_RETRIES = 10; // Increased retries for better reliability
const RETRY_DELAY_BASE = 2000; // 2 second base delay
const MAX_RETRY_DELAY = 60000; // 60 seconds max delay

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
  let result;
  if (keychain) {
    result = await fetchWithAuthAndRetry(
      getApiUrl(`/api/metadata/${id}`),
      { method: 'GET' },
      keychain
    );
  } else {
    // For unencrypted files, make a simple GET request without auth
    const response = await fetch(getApiUrl(`/api/metadata/${id}`), {
      method: 'GET'
    });
    result = { response, ok: response.ok };
  }

  if (result.ok) {
    const data = await result.response.json();
    let meta;
    if (data.encrypted !== false && keychain) {
      meta = await keychain.decryptMetadata(b64ToArray(data.metadata));
    } else {
      // For unencrypted files, metadata is base64 encoded JSON
      try {
        // Try Unicode-safe decoding first (for new uploads)
        meta = JSON.parse(decodeURIComponent(escape(atob(data.metadata))));
      } catch (e) {
        // Fall back to simple atob for old uploads
        meta = JSON.parse(atob(data.metadata));
      }
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

  const uploadRequest = {
    cancel: function() {
      canceller.cancelled = true;
      // Call the actual cancellation function if it was set up
      if (canceller.actualCancel) {
        canceller.actualCancel();
      }
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

  return uploadRequest;
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

  console.log(`Starting direct S3 upload:`, {
    totalSize: totalSize,
    isEncrypted: isEncrypted,
    timeLimit: timeLimit,
    dlimit: dlimit
  });

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

    console.log(`Upload info received:`, {
      id: uploadInfo.id,
      useSignedUrl: uploadInfo.useSignedUrl,
      multipart: uploadInfo.multipart,
      parts: uploadInfo.parts ? uploadInfo.parts.length : 0,
      partSize: uploadInfo.partSize,
      uploadId: uploadInfo.uploadId
    });

    // Check if we should use pre-signed URLs
    if (!uploadInfo.useSignedUrl) {
      console.log('Using WebSocket upload (pre-signed URLs not available)');
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

    // Handle stream vs blob for upload

    let uploadResult;

    if (uploadInfo.multipart) {
      // For multipart uploads, we can stream directly without blob conversion

      if (encrypted.getReader) {
        // Stream the data directly to S3 parts
        uploadResult = await uploadMultipartStream(
          encrypted,
          uploadInfo,
          onprogress,
          canceller,
          totalSize
        );
      } else {
        // It's already a blob/file - use existing multipart logic
        uploadResult = await uploadMultipart(
          encrypted,
          uploadInfo,
          onprogress,
          canceller
        );
      }
    } else {
      // Single part upload - need blob for simplicity
      let fileData;
      if (encrypted.getReader) {
        onprogress(1); // Show 1 byte to indicate we're working
        const blob = await new Response(encrypted).blob();
        fileData = blob.slice ? blob : new Blob([blob]);
      } else {
        fileData = encrypted;
      }
      uploadResult = await uploadSinglePart(
        fileData,
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
      throw new Error(0);
    }

    // Complete the upload
    // Convert metadata to string format for JSON transmission
    const metadataString = isEncrypted
      ? arrayToB64(new Uint8Array(metadata))
      : metadata; // For unencrypted, metadata is already a base64 string

    let completeResponse;
    let retries = 3;
    let lastError;

    // Use actual uploaded size if available from multipart upload
    const actualUploadedSize = uploadResult.actualUploadedSize || totalSize;

    // Log what we're sending to complete endpoint
    if (uploadInfo.multipart && uploadResult.partsCreated) {
      console.log(`Completing multipart upload:`, {
        id: uploadInfo.id,
        partsToComplete: uploadResult.parts.length,
        partsAllocated: uploadResult.partsAllocated,
        actualSize: actualUploadedSize,
        originalSize: totalSize
      });
    }

    while (retries > 0) {
      try {
        completeResponse = await fetch(getApiUrl('/api/upload/complete'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${bearerToken}`
          },
          body: JSON.stringify({
            id: uploadInfo.id,
            metadata: metadataString,
            ...(isEncrypted && { authKey: verifierB64 }),
            actualSize: actualUploadedSize,
            ...(uploadInfo.multipart && { parts: uploadResult.parts })
          })
        });

        if (!completeResponse.ok) {
          let errorMessage = `HTTP ${completeResponse.status}`;
          try {
            const errorBody = await completeResponse.text();
            if (errorBody) {
              errorMessage += `: ${errorBody}`;
            }
            console.error('Complete endpoint error:', {
              status: completeResponse.status,
              body: errorBody,
              partsUploaded: uploadResult.parts ? uploadResult.parts.length : 0,
              actualSize: actualUploadedSize
            });
          } catch (e) {
            // Ignore error parsing
          }
          throw new Error(errorMessage);
        }

        break; // Success, exit retry loop
      } catch (e) {
        lastError = e;
        retries--;

        console.error(
          `Complete upload attempt failed (${4 - retries}/3):`,
          e.message
        );

        if (retries > 0) {
          // Wait before retrying (exponential backoff)
          await new Promise(resolve =>
            setTimeout(resolve, (4 - retries) * 1000)
          );
        }
      }
    }

    if (!completeResponse) {
      console.error('Failed to complete upload after retries:', lastError);
      throw lastError || new Error('Failed to complete upload');
    }

    let completeInfo;
    try {
      completeInfo = await completeResponse.json();
    } catch (e) {
      // Response body may have been consumed by error handling
      console.error('Could not parse complete response:', e);
      completeInfo = {}; // Use empty object as fallback
    }

    return {
      id: uploadInfo.id,
      url: uploadInfo.completeUrl || completeInfo.url,
      ownerToken: uploadInfo.owner,
      duration: Date.now() - start
    };
  } catch (e) {
    if (canceller.cancelled) {
      throw new Error(0);
    }

    // Log the full error details before re-throwing
    console.error('=== UPLOAD FAILED ===');
    console.error('Error message:', e.message);

    // If we have a shareable message, display it prominently
    if (e.shareableMessage) {
      console.error('\n' + e.shareableMessage);
    } else if (e.failedParts) {
      // Fallback to basic error info if no summary
      console.error('Failed parts:', e.failedParts);
      if (e.partErrors) {
        console.error(
          'Part error details:',
          JSON.stringify(e.partErrors, null, 2)
        );
      }
    }

    console.error('\nStack trace:', e.stack);
    console.error('===================');

    // Add a user-friendly message to copy
    if (e.shareableMessage) {
      console.error(
        '\n📋 TO SHARE THIS ERROR FOR DEBUGGING, COPY THE ERROR SUMMARY ABOVE 📋'
      );
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

// Helper function to create consolidated error summary
function createUploadErrorSummary(
  failedParts,
  partErrors,
  uploadInfo,
  totalFileSize
) {
  const summary = {
    timestamp: new Date().toISOString(),
    totalParts: uploadInfo.parts.length,
    failedParts: failedParts.length,
    partSize: uploadInfo.partSize,
    totalFileSize: totalFileSize || 'unknown',
    failedPartNumbers: failedParts,
    errors: {}
  };

  // Group errors by type
  const errorTypes = {};
  failedParts.forEach(partNum => {
    const error = partErrors[partNum];
    if (error) {
      summary.errors[partNum] = error;
      const errorType = error.error || 'Unknown';
      if (!errorTypes[errorType]) {
        errorTypes[errorType] = [];
      }
      errorTypes[errorType].push(partNum);
    }
  });

  summary.errorTypes = errorTypes;

  // Create a shareable error message
  const shareableMessage = `
=== MULTIPART UPLOAD ERROR SUMMARY ===
Time: ${summary.timestamp}
Failed: ${summary.failedParts}/${summary.totalParts} parts
Part size: ${(summary.partSize / 1024 / 1024).toFixed(2)} MB
Total file: ${
    typeof summary.totalFileSize === 'number'
      ? (summary.totalFileSize / 1024 / 1024).toFixed(2) + ' MB'
      : summary.totalFileSize
  }

Error breakdown:
${Object.entries(errorTypes)
  .map(
    ([type, parts]) =>
      `  ${type}: ${parts.length} parts (${parts.slice(0, 5).join(', ')}${
        parts.length > 5 ? '...' : ''
      })`
  )
  .join('\n')}

Failed parts: ${failedParts.slice(0, 10).join(', ')}${
    failedParts.length > 10 ? `... and ${failedParts.length - 10} more` : ''
  }

Sample errors:
${failedParts
  .slice(0, 3)
  .map(partNum => {
    const err = partErrors[partNum];
    return err
      ? `  Part ${partNum}: ${err.error} (size: ${err.size || 'unknown'})`
      : `  Part ${partNum}: No error details`;
  })
  .join('\n')}
=====================================
  `.trim();

  return { summary, shareableMessage };
}

async function uploadMultipartStream(
  stream,
  uploadInfo,
  onprogress,
  canceller,
  originalTotalSize
) {
  const { parts, partSize } = uploadInfo;
  const partProgress = {}; // Track progress per part
  const partExpectedSizes = {}; // Track expected size for each part
  let totalExpectedSize = 0; // Track total expected upload size
  const partErrors = {}; // Track specific errors for each part

  console.log(
    `Starting multipart stream upload with up to ${parts.length} parts allocated, part size: ${partSize}, expected total: ${originalTotalSize}`
  );

  // Initialize all parts with 0 progress upfront
  parts.forEach(part => {
    partProgress[part.partNumber] = 0;
    partExpectedSizes[part.partNumber] = 0; // Will be set when we create the part
  });

  // Set up cancellation for all XHR requests
  canceller.actualCancel = () => {
    canceller.cancelled = true;
    if (canceller.xhrs) {
      canceller.xhrs.forEach(xhr => {
        if (xhr.readyState !== XMLHttpRequest.DONE) {
          xhr.abort();
        }
      });
    }
  };

  const reader = stream.getReader();
  let currentPartIndex = 0;
  let currentPartData = [];
  let currentPartSize = 0;
  let leftoverData = null; // Store data that didn't fit in the previous part

  const allUploads = []; // Track all upload promises
  const uploadPartNumbers = []; // Track which part number each upload corresponds to

  try {
    let streamDone = false;

    while (currentPartIndex < parts.length) {
      const part = parts[currentPartIndex];
      const targetPartSize = partSize;

      // Add any leftover data from the previous part first
      if (leftoverData) {
        currentPartData.push(leftoverData);
        currentPartSize += leftoverData.length;
        leftoverData = null;
      }

      // Read data for this part (only if we haven't reached the end of stream)
      while (currentPartSize < targetPartSize && !streamDone) {
        const { done, value } = await reader.read();

        if (done) {
          streamDone = true;
          console.log(
            `Stream ended at part ${currentPartIndex + 1}/${
              parts.length
            }, bytes read so far: ${totalExpectedSize + currentPartSize}`
          );
          break;
        }

        if (canceller.cancelled) {
          throw new Error(0);
        }

        // Check if adding this chunk would exceed the target part size
        const wouldExceed = currentPartSize + value.length > targetPartSize;

        if (wouldExceed && currentPartIndex < parts.length - 1) {
          // For non-final parts, we must not exceed the target size
          // Split the chunk to fit exactly
          const remainingSpace = targetPartSize - currentPartSize;
          if (remainingSpace > 0) {
            const partialChunk = value.slice(0, remainingSpace);
            currentPartData.push(partialChunk);
            currentPartSize += partialChunk.length;

            // Store the remaining data for the next part
            leftoverData = value.slice(remainingSpace);
          } else {
            // No space left, store the entire chunk for next part
            leftoverData = value;
          }
          break; // Exit the reading loop for this part
        } else {
          // Safe to add the whole chunk
          currentPartData.push(value);
          currentPartSize += value.length;
        }

        // No progress update during reading phase
      }

      // Upload if we have data for this part (even if stream is done)
      if (currentPartData.length > 0) {
        // Create blob from accumulated chunks for this part
        const partBlob = new Blob(currentPartData);

        console.log(`Creating part ${part.partNumber}:`, {
          partSize: partBlob.size,
          targetSize: targetPartSize,
          streamDone: streamDone,
          isLastPart: currentPartIndex === parts.length - 1
        });

        // Track the expected size for this part
        partExpectedSizes[part.partNumber] = partBlob.size;
        totalExpectedSize += partBlob.size;

        // Upload this part
        const uploadPromise = uploadPartWithRetry(
          partBlob,
          part.url,
          part.partNumber,
          loaded => {
            // Update upload progress
            if (loaded > 0) {
              partProgress[part.partNumber] = loaded;
              // Calculate actual bytes uploaded
              const actualUploaded = Object.values(partProgress).reduce(
                (sum, progress) => sum + progress,
                0
              );

              // Never report more than the original total size
              // This prevents progress from exceeding 100%
              const reportedProgress = originalTotalSize
                ? Math.min(actualUploaded, originalTotalSize)
                : actualUploaded;

              onprogress(reportedProgress);
            }
          },
          canceller
        )
          .then(result => {
            // Keep the part at its expected size when completed
            partProgress[part.partNumber] = partExpectedSizes[part.partNumber];
            console.log(
              `Part ${part.partNumber} uploaded successfully (size: ${partBlob.size} bytes)`
            );

            // Report actual progress
            const totalUploaded = Object.values(partProgress).reduce(
              (sum, progress) => sum + progress,
              0
            );

            // Never report more than the original total size
            const reportedProgress = originalTotalSize
              ? Math.min(totalUploaded, originalTotalSize)
              : totalUploaded;

            onprogress(reportedProgress);

            return result;
          })
          .catch(error => {
            // Capture the error details for this part
            partErrors[part.partNumber] = {
              error: error.message,
              size: partBlob.size,
              timestamp: new Date().toISOString()
            };
            console.error(`Part ${part.partNumber} failed after all retries:`, {
              error: error.message,
              partSize: partBlob.size,
              partNumber: part.partNumber
            });
            throw error;
          });

        allUploads.push(uploadPromise);
        uploadPartNumbers.push(part.partNumber); // Track which part this upload is for

        // Reset for next part
        currentPartData = [];
        currentPartSize = 0;
      } else if (streamDone) {
        // No more data and stream is done, break out
        break;
      }

      currentPartIndex++;
    }

    // If stream ended early, log the mismatch but don't create empty parts
    if (streamDone && currentPartIndex < parts.length) {
      console.warn(
        `Stream ended early at part ${currentPartIndex}/${parts.length}. Server allocated too many parts.`
      );
      console.warn(
        `Expected size: ${originalTotalSize}, Actual size: ${totalExpectedSize}`
      );
    }

    // Mark that all parts have been created
    console.log(
      `Created ${uploadPartNumbers.length} parts from stream (allocated ${parts.length})`
    );

    // Log detailed information about the upload
    console.log(`Stream upload details:`, {
      totalBytesUploaded: totalExpectedSize,
      originalTotalSize: originalTotalSize,
      partsCreated: uploadPartNumbers.length,
      partsAllocated: parts.length,
      averagePartSize: totalExpectedSize / uploadPartNumbers.length,
      expectedPartSize: partSize,
      streamEnded: true
    });

    // Final progress update now that we know the true total
    const finalProgress = Object.values(partProgress).reduce(
      (sum, progress) => sum + progress,
      0
    );
    // Report progress, but cap at original total size
    const reportedProgress = originalTotalSize
      ? Math.min(finalProgress, originalTotalSize)
      : finalProgress;
    if (reportedProgress > 0) {
      onprogress(reportedProgress);
    }

    // Wait for all uploads to complete
    const allResults = await Promise.allSettled(allUploads);

    if (canceller.cancelled) {
      throw new Error(0);
    }

    // Process results and collect successful uploads
    const successfulParts = [];
    const failedParts = [];

    allResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        successfulParts.push(result.value);
      } else {
        // Use the tracked part number, not parts[index]
        const partNumber = uploadPartNumbers[index];
        failedParts.push(partNumber);
        // Log if we don't already have error details
        if (!partErrors[partNumber]) {
          partErrors[partNumber] = {
            error: (result.reason && result.reason.message) || 'Unknown error',
            timestamp: new Date().toISOString()
          };
        }
      }
    });

    console.log(
      `Upload results: ${successfulParts.length} successful, ${failedParts.length} failed out of ${uploadPartNumbers.length} parts attempted (${parts.length} parts allocated)`
    );

    // Ensure final progress shows 100% completion if all succeeded
    if (failedParts.length === 0) {
      // Report the original total size to indicate 100% completion
      // When we successfully upload all parts we created (even if less than allocated),
      // we should report 100% completion
      const finalReportedSize = originalTotalSize || totalExpectedSize;
      onprogress(finalReportedSize);
      console.log(
        `All ${uploadPartNumbers.length} parts uploaded successfully. Reporting 100% completion (${finalReportedSize} bytes)`
      );
    }

    // Check if all parts were uploaded successfully
    if (failedParts.length > 0) {
      // Generate consolidated error summary (use actual attempted parts count)
      const modifiedUploadInfo = {
        ...uploadInfo,
        parts: uploadPartNumbers.map(num => ({ partNumber: num }))
      };
      const { summary, shareableMessage } = createUploadErrorSummary(
        failedParts,
        partErrors,
        modifiedUploadInfo,
        totalExpectedSize
      );

      console.error(shareableMessage);
      console.error('Full error details:', summary);

      const error = new Error(
        `Failed to upload ${failedParts.length} parts. Check console for detailed error summary.`
      );
      error.failedParts = failedParts;
      error.partErrors = partErrors;
      error.summary = summary;
      error.shareableMessage = shareableMessage;

      throw error;
    }

    return {
      parts: successfulParts.sort((a, b) => a.PartNumber - b.PartNumber),
      actualUploadedSize: totalExpectedSize,
      partsCreated: uploadPartNumbers.length,
      partsAllocated: parts.length
    };
  } finally {
    // Clean up reader
    try {
      reader.releaseLock();
    } catch (e) {
      // Reader may already be released
    }
  }
}

async function uploadMultipart(file, uploadInfo, onprogress, canceller) {
  const { parts, partSize } = uploadInfo;
  const completedParts = [];
  const partProgress = {}; // Track progress per part
  const totalFileSize = file.size; // Track actual total file size
  const partErrors = {}; // Track specific errors for each part

  console.log(
    `Starting multipart upload with ${parts.length} parts, part size: ${partSize}, total file size: ${totalFileSize}`
  );

  // Initialize all parts with 0 progress upfront to avoid jumping
  parts.forEach(part => {
    partProgress[part.partNumber] = 0;
  });

  // Set up cancellation for all XHR requests
  canceller.actualCancel = () => {
    canceller.cancelled = true;
    if (canceller.xhrs) {
      canceller.xhrs.forEach(xhr => {
        if (xhr.readyState !== XMLHttpRequest.DONE) {
          xhr.abort();
        }
      });
    }
  };

  // Upload parts in parallel (limit concurrency)
  const CONCURRENT_UPLOADS = 3;
  const uploadPromises = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const start = (part.partNumber - 1) * partSize;
    const end = Math.min(start + partSize, file.size);

    const partBlob = file.slice(start, end);

    const uploadPromise = uploadPartWithRetry(
      partBlob,
      part.url,
      part.partNumber,
      loaded => {
        // Only update progress if we have actual progress to avoid flickering
        if (loaded > 0) {
          partProgress[part.partNumber] = loaded;
          // Calculate total progress from all parts, but cap at totalFileSize
          const totalUploaded = Math.min(
            Object.values(partProgress).reduce(
              (sum, progress) => sum + progress,
              0
            ),
            totalFileSize
          );
          onprogress(totalUploaded);
        }
      },
      canceller
    )
      .then(result => {
        console.log(
          `Part ${part.partNumber} uploaded successfully (size: ${partBlob.size} bytes)`
        );
        return result;
      })
      .catch(error => {
        // Capture the error details for this part
        partErrors[part.partNumber] = {
          error: error.message,
          size: partBlob.size,
          timestamp: new Date().toISOString()
        };
        console.error(`Part ${part.partNumber} failed:`, {
          error: error.message,
          partSize: partBlob.size,
          partNumber: part.partNumber
        });
        throw error;
      });

    uploadPromises.push(uploadPromise);

    // Limit concurrent uploads
    if (uploadPromises.length >= CONCURRENT_UPLOADS) {
      const completed = await Promise.allSettled(uploadPromises);
      completed.forEach(result => {
        if (result.status === 'fulfilled') {
          completedParts.push(result.value);
        }
      });
      uploadPromises.length = 0;

      // Check if cancelled
      if (canceller.cancelled) {
        throw new Error(0);
      }
    }
  }

  // Upload remaining parts
  if (uploadPromises.length > 0) {
    const completed = await Promise.allSettled(uploadPromises);
    let hasErrors = false;
    completed.forEach(result => {
      if (result.status === 'fulfilled') {
        completedParts.push(result.value);
      } else {
        hasErrors = true;
        console.error('Part upload failed:', result.reason);
      }
    });

    // Check if cancelled
    if (canceller.cancelled) {
      throw new Error(0);
    }

    // If we have errors, wait a bit and see if we should retry the whole batch
    if (hasErrors && completedParts.length < parts.length) {
      console.log('Some parts failed, checking if we can continue...');
    }
  }

  console.log(
    `Upload completed: ${completedParts.length} successful out of ${parts.length} total parts`
  );

  // Check if all parts were uploaded successfully
  if (completedParts.length !== parts.length) {
    const failedParts = [];
    const completedPartNumbers = new Set(completedParts.map(p => p.PartNumber));

    for (const part of parts) {
      if (!completedPartNumbers.has(part.partNumber)) {
        failedParts.push(part.partNumber);
        // Add error details if we don't have them
        if (!partErrors[part.partNumber]) {
          partErrors[part.partNumber] = {
            error: 'Upload failed - no specific error captured',
            timestamp: new Date().toISOString()
          };
        }
      }
    }

    // Generate consolidated error summary
    const { summary, shareableMessage } = createUploadErrorSummary(
      failedParts,
      partErrors,
      uploadInfo,
      totalFileSize
    );

    console.error(shareableMessage);
    console.error('Full error details:', summary);

    const error = new Error(
      `Failed to upload ${failedParts.length} parts. Check console for detailed error summary.`
    );
    error.failedParts = failedParts;
    error.partErrors = partErrors;
    error.summary = summary;
    error.shareableMessage = shareableMessage;

    throw error;
  }

  return {
    parts: completedParts.sort((a, b) => a.PartNumber - b.PartNumber)
  };
}

async function uploadPart(partBlob, url, partNumber, onProgress, canceller) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    // Check if already cancelled
    if (canceller.cancelled) {
      reject(new Error(0));
      return;
    }

    // Store the xhr for cancellation
    if (!canceller.xhrs) {
      canceller.xhrs = [];
    }
    canceller.xhrs.push(xhr);

    let lastProgressTime = Date.now();
    let lastProgressLoaded = 0;

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) {
        onProgress(e.loaded);

        // Log upload speed periodically (every 5 seconds)
        const now = Date.now();
        if (now - lastProgressTime > 5000) {
          const bytesPerSecond =
            (e.loaded - lastProgressLoaded) / ((now - lastProgressTime) / 1000);
          const speedMB = (bytesPerSecond / (1024 * 1024)).toFixed(2);
          console.log(
            `Part ${partNumber} upload progress: ${e.loaded}/${
              e.total
            } bytes (${Math.round(
              (e.loaded * 100) / e.total
            )}%), speed: ${speedMB} MB/s`
          );
          lastProgressTime = now;
          lastProgressLoaded = e.loaded;
        }
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
        // Try to get more information about the error
        let errorDetails = `HTTP ${xhr.status}`;
        if (xhr.statusText) {
          errorDetails += ` (${xhr.statusText})`;
        }
        if (xhr.responseText) {
          try {
            // Try to parse JSON error response
            const errorResponse = JSON.parse(xhr.responseText);
            errorDetails += ` - ${errorResponse.message ||
              errorResponse.error ||
              xhr.responseText}`;
          } catch (e) {
            // Not JSON, use raw text
            errorDetails += ` - ${xhr.responseText.substring(0, 200)}`; // Limit error message length
          }
        }

        console.error(`Part ${partNumber} HTTP error:`, {
          status: xhr.status,
          statusText: xhr.statusText,
          responseText: xhr.responseText
            ? xhr.responseText.substring(0, 500)
            : null,
          url: url.replace(/\?.*/, '?...') // Log URL without sensitive query params
        });

        reject(new Error(`${errorDetails} for part ${partNumber}`));
      }
    });

    xhr.addEventListener('error', () => {
      console.error(`Part ${partNumber} network error:`, {
        readyState: xhr.readyState,
        status: xhr.status,
        statusText: xhr.statusText,
        url: url.replace(/\?.*/, '?...') // Log URL without sensitive query params
      });
      reject(new Error(`Network error for part ${partNumber}`));
    });

    xhr.addEventListener('timeout', () => {
      console.error(`Part ${partNumber} timeout after ${xhr.timeout}ms`);
      reject(new Error(`Timeout for part ${partNumber}`));
    });

    xhr.open('PUT', url);
    xhr.timeout = 120000; // 2 minute timeout per part
    xhr.send(partBlob);
  });
}

function isRetriableError(error) {
  // Network errors, 5xx errors, and 429 (too many requests) errors
  const errorMessage = error.message || '';

  // Network errors
  if (errorMessage.includes('Network error')) {
    return true;
  }

  // Timeout errors
  if (errorMessage.includes('Timeout')) {
    return true;
  }

  // HTTP errors that are retryable
  if (errorMessage.includes('HTTP')) {
    // 5xx server errors
    if (errorMessage.match(/HTTP 5\d\d/)) {
      return true;
    }
    // 429 Too Many Requests
    if (errorMessage.includes('HTTP 429')) {
      return true;
    }
    // 408 Request Timeout
    if (errorMessage.includes('HTTP 408')) {
      return true;
    }
    // 503 Service Unavailable
    if (errorMessage.includes('HTTP 503')) {
      return true;
    }
    // 504 Gateway Timeout
    if (errorMessage.includes('HTTP 504')) {
      return true;
    }
  }

  return false;
}

async function uploadPartWithRetry(
  partBlob,
  url,
  partNumber,
  onProgress,
  canceller,
  retryCount = 0
) {
  try {
    if (retryCount === 0) {
      console.log(
        `Starting upload of part ${partNumber} (size: ${partBlob.size} bytes)`
      );
    }
    return await uploadPart(partBlob, url, partNumber, onProgress, canceller);
  } catch (error) {
    // Don't retry if cancelled
    if (canceller.cancelled || error.message === '0') {
      console.log(`Part ${partNumber} upload cancelled`);
      throw error;
    }

    // Log the error details
    console.error(
      `Part ${partNumber} upload attempt ${retryCount + 1} failed:`,
      {
        error: error.message,
        partNumber: partNumber,
        partSize: partBlob.size,
        isRetriable: isRetriableError(error),
        retryCount: retryCount
      }
    );

    // Check if we should retry
    if (retryCount < MAX_RETRIES && isRetriableError(error)) {
      // Calculate exponential backoff with jitter
      const baseDelay = RETRY_DELAY_BASE * Math.pow(2, retryCount);
      const jitter = Math.random() * 0.3 * baseDelay; // up to 30% jitter
      const delay = Math.min(baseDelay + jitter, MAX_RETRY_DELAY);

      console.log(
        `Retrying part ${partNumber} after ${Math.round(
          delay
        )}ms delay (attempt ${retryCount + 2}/${MAX_RETRIES + 1}), ` +
          `error was: ${error.message}`
      );

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));

      // Check if cancelled during delay
      if (canceller.cancelled) {
        console.log(`Part ${partNumber} retry cancelled during delay`);
        throw new Error(0);
      }

      // Reset progress for this part before retry
      onProgress(0);

      // Retry the upload
      return uploadPartWithRetry(
        partBlob,
        url,
        partNumber,
        onProgress,
        canceller,
        retryCount + 1
      );
    }

    // Max retries exhausted or non-retryable error
    const finalMessage =
      retryCount > 0
        ? `Failed to upload part ${partNumber} after ${retryCount +
            1} attempts (max retries: ${MAX_RETRIES + 1})`
        : `Failed to upload part ${partNumber} - error is not retriable`;

    console.error(finalMessage, {
      error: error.message,
      partNumber: partNumber,
      partSize: partBlob.size,
      totalAttempts: retryCount + 1,
      wasRetriable: isRetriableError(error)
    });

    // Include more context in the thrown error
    const enhancedError = new Error(
      `Part ${partNumber} upload failed: ${error.message} (after ${retryCount +
        1} attempts)`
    );
    enhancedError.originalError = error;
    enhancedError.partNumber = partNumber;
    enhancedError.attempts = retryCount + 1;
    throw enhancedError;
  }
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

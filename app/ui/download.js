/* global downloadMetadata */
const html = require('choo/html');
const archiveTile = require('./archiveTile');
const modal = require('./modal');
const noStreams = require('./noStreams');
const notFound = require('./notFound');
const downloadPassword = require('./downloadPassword');
const downloadCompleted = require('./downloadCompleted');
const downloadStarted = require('./downloadStarted');
const BIG_SIZE = 1024 * 1024 * 256;

function createFileInfo(state) {
  const encrypted = downloadMetadata.encrypted !== false;
  console.log('DEBUG: createFileInfo called with:', {
    stateParamsId: state.params.id,
    stateParamsKey: state.params.key ? 'present' : 'missing',
    downloadMetadataEncrypted: downloadMetadata.encrypted,
    downloadMetadataNonce: downloadMetadata.nonce ? 'present' : 'missing',
    downloadMetadataPwd: downloadMetadata.pwd,
    downloadMetadataStatus: downloadMetadata.status
  });

  const fileInfo = {
    id: state.params.id,
    secretKey: encrypted ? state.params.key : null,
    nonce: downloadMetadata.nonce,
    requiresPassword: downloadMetadata.pwd,
    encrypted: encrypted
  };

  console.log('DEBUG: Created fileInfo:', {
    id: fileInfo.id,
    secretKey: fileInfo.secretKey ? 'present' : 'missing',
    nonce: fileInfo.nonce ? 'present' : 'missing',
    requiresPassword: fileInfo.requiresPassword,
    encrypted: fileInfo.encrypted
  });

  return fileInfo;
}

function downloading(state, emit) {
  return html`
    <div
      class="flex flex-col w-full h-full items-center md:justify-center md:-mt-8"
    >
      <h1 class="text-3xl font-medium mb-4">
        ${state.translate('downloadingTitle')}
      </h1>
      ${archiveTile.downloading(state, emit)}
    </div>
  `;
}

function preview(state, emit) {
  if (
    !state.capabilities.streamDownload &&
    state.fileInfo.size > BIG_SIZE &&
    state.fileInfo.encrypted
  ) {
    return noStreams(state, emit);
  }
  return html`
    <div
      class="flex flex-col w-full max-w-md h-full mx-auto items-center justify-center"
    >
      <h1 class="text-3xl font-medium mb-4">
        ${state.translate('downloadTitle')}
      </h1>
      <p
        class="w-full text-grey-80 text-center leading-normal dark:text-grey-40"
      >
        ${state.translate('downloadDescription')}
      </p>
      ${archiveTile.preview(state, emit)}
    </div>
  `;
}

module.exports = function(state, emit) {
  let content = '';
  if (!state.fileInfo) {
    state.fileInfo = createFileInfo(state);
    if (downloadMetadata.status === 404) {
      return notFound(state);
    }
    if (!state.fileInfo.nonce && state.fileInfo.encrypted) {
      // coming from something like the browser back button
      return location.reload();
    }
  }

  if (!state.transfer && !state.fileInfo.requiresPassword) {
    emit('getMetadata');
  }

  if (state.transfer) {
    switch (state.transfer.state) {
      case 'downloading':
      case 'decrypting':
        content = downloading(state, emit);
        break;
      case 'complete':
        // Show "Download started" for unencrypted files, "Download completed" for encrypted
        if (!state.fileInfo.encrypted) {
          content = downloadStarted(state);
        } else {
          content = downloadCompleted(state);
        }
        break;
      default:
        content = preview(state, emit);
    }
  } else if (state.fileInfo.requiresPassword && !state.fileInfo.password) {
    content = downloadPassword(state, emit);
  }
  return html`
    <main class="main">
      ${state.modal && modal(state, emit)}
      <section
        class="relative h-full w-full p-6 md:p-8 md:rounded-xl md:shadow-big"
      >
        ${content}
      </section>
    </main>
  `;
};

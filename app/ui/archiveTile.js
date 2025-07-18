/* global Android */

const html = require('choo/html');
const raw = require('choo/html/raw');
const assets = require('../../common/assets');
const {
  bytes,
  copyToClipboard,
  list,
  percent,
  platform,
  timeLeft
} = require('../utils');
const expiryOptions = require('./expiryOptions');

function expiryInfo(translate, archive) {
  const l10n = timeLeft(archive.expiresAt - Date.now());
  return raw(
    translate('archiveExpiryInfo', {
      downloadCount: translate('downloadCount', {
        num: archive.dlimit - archive.dtotal
      }),
      timespan: translate(l10n.id, l10n)
    })
  );
}

function password(state) {
  const MAX_LENGTH = 4096;

  if (!state.archive.encrypted) {
    return '';
    // return html`
    //   <div class="mt-4 mb-2 px-1 pb-2">
    //     <div class="text-sm text-grey-70 dark:text-grey-40">
    //       ${state.translate('passwordNotAvailable')}
    //     </div>
    //   </div>
    // `;
  }

  return html`
    <div class="mt-4 mb-2 px-1">
      <input
        id="autocomplete-decoy"
        class="hidden"
        type="password"
        value="lol"
      />
      <div class="flex items-center mb-2">
        <input
          id="add-password"
          type="checkbox"
          class="mr-2"
          ${state.archive.password ? 'checked' : ''}
          autocomplete="off"
          onchange="${togglePasswordInput}"
        />
        <label for="add-password" class="text-sm">
          ${state.translate('addPassword')}
        </label>
      </div>
      <div class="relative inline-block my-1">
        <input
          id="password-input"
          class="${state.archive.password
            ? ''
            : 'invisible'} border-default rounded-default focus:border-primary leading-normal my-1 py-1 px-2 h-8 dark:bg-grey-80"
          autocomplete="off"
          maxlength="${MAX_LENGTH}"
          type="password"
          oninput="${inputChanged}"
          onfocus="${focused}"
          placeholder="${state.translate('unlockInputPlaceholder')}"
          value="${state.archive.password || ''}"
        />
        <button
          id="password-preview-button"
          type="button"
          class="${state.archive.password
            ? ''
            : 'invisible'} absolute top-0 right-0 w-8 h-8"
          onclick="${onPasswordPreviewButtonclicked}"
        >
          <img
            src="${assets.get('eye.svg')}"
            width="22"
            height="22"
            class="m-auto mt-2"
          />
        </button>
      </div>
      <label
        id="password-msg"
        for="password-input"
        class="block text-xs text-grey-70 dark:text-grey-40"
      ></label>
    </div>
  `;

  function onPasswordPreviewButtonclicked(event) {
    event.preventDefault();
    const input = document.getElementById('password-input');
    const eyeIcon = event.currentTarget.querySelector('img');

    if (input.type === 'password') {
      input.type = 'text';
      eyeIcon.src = assets.get('eye-off.svg');
    } else {
      input.type = 'password';
      eyeIcon.src = assets.get('eye.svg');
    }

    input.focus();
  }

  function togglePasswordInput(event) {
    event.stopPropagation();
    const checked = event.target.checked;
    const input = document.getElementById('password-input');
    const passwordPreviewButton = document.getElementById(
      'password-preview-button'
    );
    if (checked) {
      input.classList.remove('invisible');
      passwordPreviewButton.classList.remove('invisible');
      input.focus();
    } else {
      input.classList.add('invisible');
      passwordPreviewButton.classList.add('invisible');
      input.value = '';
      document.getElementById('password-msg').textContent = '';
      state.archive.password = null;
    }
  }

  function inputChanged() {
    const passwordInput = document.getElementById('password-input');
    const pwdmsg = document.getElementById('password-msg');
    const password = passwordInput.value;
    const length = password.length;

    if (length === MAX_LENGTH) {
      pwdmsg.textContent = state.translate('maxPasswordLength', {
        length: MAX_LENGTH
      });
    } else {
      pwdmsg.textContent = '';
    }
    state.archive.password = password;
  }

  function focused(event) {
    event.preventDefault();
    const el = document.getElementById('password-input');
    if (el.placeholder !== state.translate('unlockInputPlaceholder')) {
      el.placeholder = '';
    }
  }
}

function encryption(state, emit) {
  // Check if any files are larger than 2GB
  const hasLargeFiles = state.archive.files.some(
    file => file.size > 2 * 1024 * 1024 * 1024
  );
  const showWarning = state.archive.encrypted && hasLargeFiles;

  return html`
    <div class="mt-4 mb-2 px-1">
      <div class="flex items-center mb-2">
        <input
          id="encrypt-files"
          type="checkbox"
          class="mr-2"
          ${state.archive.encrypted ? 'checked' : ''}
          autocomplete="off"
          onchange="${toggleEncryption}"
        />
        <label for="encrypt-files" class="text-sm">
          ${state.translate('encryptFiles')}
        </label>
      </div>
      <div class="text-xs text-grey-70 dark:text-grey-40 mt-1 mb-2">
        ${state.translate('encryptionHelp')}
      </div>
      ${showWarning
        ? html`
            <div class="text-xs mt-1 mb-2 py-2 rounded leading-loose">
              ⚠️ ${state.translate('encryptionLargeFileWarning')}
            </div>
          `
        : ''}
    </div>
  `;

  function toggleEncryption(event) {
    event.stopPropagation();
    const checked = event.target.checked;
    state.archive.encrypted = checked;
    // Clear password when encryption is disabled
    if (!checked) {
      state.archive.password = null;
    }
    emit('render');
  }
}

function fileInfo(file, action) {
  return html`
    <send-file class="flex flex-row items-center p-3 w-full">
      <svg class="h-8 w-8 text-primary">
        <use xlink:href="${assets.get('blue_file.svg')}#icon"/>
      </svg>
      <p class="ml-4 w-full">
        <h1 class="text-base font-medium word-break-all">${file.name}</h1>
        <div class="text-sm font-normal opacity-75 pt-1">${bytes(
          file.size
        )}</div>
      </p>
      ${action}
    </send-file>`;
}

function archiveInfo(archive, action) {
  return html`
    <p class="w-full flex items-center">
      <svg class="h-8 w-6 mr-3 flex-shrink-0 text-primary">
        <use xlink:href="${assets.get('blue_file.svg')}#icon"/>
      </svg>
      <p class="flex-grow">
        <h1 class="text-base font-medium word-break-all">${archive.name}</h1>
        <div class="text-sm font-normal opacity-75 pt-1">${bytes(
          archive.size
        )}</div>
      </p>
      ${action}
    </p>`;
}

function archiveDetails(translate, archive) {
  if (
    archive.manifest &&
    archive.manifest.files &&
    archive.manifest.files.length > 1
  ) {
    return html`
      <details
        class="w-full pb-1"
        ${archive.open ? 'open' : ''}
        ontoggle="${toggled}"
      >
        <summary
          class="flex items-center link-primary text-sm cursor-pointer outline-none"
        >
          <svg
            class="fill-current w-3 h-3 mr-1"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
          >
            <path
              d="M12.95 10.707l.707-.707L8 4.343 6.586 5.757 10.828 10l-4.242 4.243L8 15.657l4.95-4.95z"
            />
          </svg>
          ${translate('fileCount', {
            num: archive.manifest.files.length
          })}
        </summary>
        ${list(archive.manifest.files.map(f => fileInfo(f)))}
      </details>
    `;
  }
  function toggled(event) {
    event.stopPropagation();
    archive.open = event.target.open;
  }
}

module.exports = function(state, emit, archive) {
  const copyOrShare =
    state.capabilities.share || platform() === 'android'
      ? html`
          <button
            class="link-primary self-end flex items-center"
            onclick=${share}
            title="Share link"
          >
            <svg class="h-3 w-3 mr-2">
              <use xlink:href="${assets.get('share-24.svg')}#icon" />
            </svg>
            Share link
          </button>
        `
      : html`
          <button
            class="link-primary focus:outline self-end flex items-center"
            onclick=${copy}
            title="${state.translate('copyLinkButton')}"
          >
            <svg class="h-3 w-3 mr-2">
              <use xlink:href="${assets.get('copy-16.svg')}#icon" />
            </svg>
            ${state.translate('copyLinkButton')}
          </button>
        `;
  const dl =
    platform() === 'web'
      ? html`
          <a
            class="flex items-baseline link-primary"
            href="${archive.url}"
            title="${state.translate('downloadButtonLabel')}"
            tabindex="0"
          >
            <svg class="h-3 w-3 mr-2">
              <use xlink:href="${assets.get('dl.svg')}#icon" />
            </svg>
            ${state.translate('downloadButtonLabel')}
          </a>
        `
      : html`
          <div></div>
        `;
  return html`
    <send-archive
      id="archive-${archive.id}"
      class="flex flex-col items-center rounded-default shadow-light bg-white p-4 w-full dark:bg-grey-90 dark:border-default dark:border-grey-70"
    >
      ${archiveInfo(
        archive,
        html`
          <input
            type="image"
            class="self-start flex-shrink-0 text-white hover:opacity-75 focus:outline"
            alt="${state.translate('deleteButtonHover')}"
            title="${state.translate('deleteButtonHover')}"
            src="${assets.get('close-16.svg')}"
            onclick=${del}
          />
        `
      )}
      <div class="text-sm opacity-75 w-full mt-2 mb-2">
        ${expiryInfo(state.translate, archive)}
      </div>
      ${archiveDetails(state.translate, archive)}
      <hr class="w-full border-t my-4 border-grey-40 dark:border-grey-70" />
      <div class="flex justify-between w-full text-sm">
        ${dl} ${copyOrShare}
      </div>
    </send-archive>
  `;

  function copy(event) {
    event.stopPropagation();
    copyToClipboard(archive.url);
    const text = event.target.lastChild;
    text.textContent = state.translate('copiedUrl');
    setTimeout(
      () => (text.textContent = state.translate('copyLinkButton')),
      1000
    );
  }

  function del(event) {
    event.stopPropagation();
    emit('delete', archive);
  }

  async function share(event) {
    event.stopPropagation();
    if (platform() === 'android') {
      Android.shareUrl(archive.url);
    } else {
      try {
        await navigator.share({
          title: state.translate('-send-brand'),
          // text: `Download "${archive.name}" with Send: simple, safe file sharing`,
          //state.translate('shareMessage', { name }),
          url: archive.url
        });
      } catch (e) {
        // ignore
      }
    }
  }
};

module.exports.wip = function(state, emit) {
  return html`
    <send-upload-area
      class="flex flex-col bg-white h-full w-full dark:bg-grey-90"
      id="wip"
    >
      ${list(
        Array.from(state.archive.files)
          .reverse()
          .map(f =>
            fileInfo(f, remove(f, state.translate('deleteButtonHover')))
          ),
        'flex-shrink bg-grey-10 rounded-t overflow-y-auto px-6 py-4 md:h-full md:max-h-half-screen dark:bg-black',
        'bg-white px-2 my-2 shadow-light rounded-default dark:bg-grey-90 dark:border-default dark:border-grey-80'
      )}
      <div
        class="flex-shrink-0 flex-grow flex items-end py-4 bg-grey-10 rounded-b mb-1 font-medium dark:bg-grey-90"
      >
        <input
          id="file-upload"
          class="opacity-0 w-0 h-0 appearance-none absolute overflow-hidden"
          type="file"
          multiple
          onfocus="${focus}"
          onblur="${blur}"
          onchange="${add}"
        />
        <div
          for="file-upload"
          class="flex flex-row items-center justify-between w-full p-2"
        >
          <div class="flex items-center">
            <label
              for="file-upload"
              class="text-sm flex items-center cursor-pointer mr-4"
              title="${state.translate('addFilesButton')}"
            >
              <svg class="w-3 h-3 mr-2 link-primary">
                <use xlink:href="${assets.get('addfiles.svg')}#plus" />
              </svg>
              ${state.translate('addFilesButton')}
            </label>
          </div>
          <div class="font-normal text-sm text-grey-70 dark:text-grey-40">
            ${state.translate('totalSize', {
              size: bytes(state.archive.size)
            })}
          </div>
        </div>
      </div>
      ${expiryOptions(state, emit)} ${encryption(state, emit)}
      ${password(state, emit)}
      <button
        id="upload-btn"
        class="btn rounded-lg flex-shrink-0 focus:outline plausible-event-name=Upload"
        title="${state.translate('uploadButton')}"
        onclick="${upload}"
      >
        ${state.translate('uploadButton')}
      </button>
    </send-upload-area>
  `;

  function focus(event) {
    event.target.nextElementSibling.firstElementChild.classList.add('outline');
  }

  function blur(event) {
    event.target.nextElementSibling.firstElementChild.classList.remove(
      'outline'
    );
  }

  function upload(event) {
    window.scrollTo(0, 0);
    event.preventDefault();
    event.target.disabled = true;
    if (!state.uploading) {
      emit('upload');
    }
  }

  function add(event) {
    event.preventDefault();
    const newFiles = Array.from(event.target.files);

    emit('addFiles', { files: newFiles });
    setTimeout(() => {
      document
        .querySelector('#wip > ul > li:first-child')
        .scrollIntoView({ block: 'center' });
    });
  }

  function remove(file, desc) {
    return html`
      <input
        type="image"
        class="self-center text-white ml-4 h-3 hover:opacity-75 focus:outline"
        alt="${desc}"
        title="${desc}"
        src="${assets.get('close-16.svg')}"
        onclick="${del}"
      />
    `;
    function del(event) {
      event.stopPropagation();
      emit('removeUpload', file);
    }
  }
};

module.exports.uploading = function(state, emit) {
  const progress = state.transfer.progressRatio;
  const isInitializing = progress === 0 || progress === undefined;
  const progressPercent = isInitializing ? 'Preparing...' : percent(progress);
  const archive = state.archive;
  return html`
    <send-upload-area
      id="${archive.id}"
      class="flex flex-col items-start rounded-default shadow-light bg-white p-4 w-full dark:bg-grey-90"
    >
      ${archiveInfo(archive)}
      <div class="text-xs opacity-75 w-full mt-2 mb-2">
        ${expiryInfo(state.translate, {
          dlimit: state.archive.dlimit,
          dtotal: 0,
          expiresAt: Date.now() + 500 + state.archive.timeLimit * 1000
        })}
      </div>
      <div class="link-primary text-sm font-medium mt-2">
        ${progressPercent}
      </div>
      <progress class="my-3" value="${isInitializing ? 0 : progress}"
        >${progressPercent}</progress
      >
      <button
        class="link-primary self-end font-medium"
        onclick=${cancel}
        title="${state.translate('deletePopupCancel')}"
      >
        ${state.translate('deletePopupCancel')}
      </button>
    </send-upload-area>
  `;

  function cancel(event) {
    event.stopPropagation();
    event.target.disabled = true;
    emit('cancel');
  }
};

module.exports.empty = function(state, emit) {
  const upsell =
    state.user.loggedIn || !state.capabilities.account
      ? ''
      : html`
          <button
            class="center font-medium text-sm link-primary mt-4 mb-2"
            onclick="${event => {
              event.stopPropagation();
              emit('signup-cta', 'drop');
            }}"
          >
            ${state.translate('signInSizeBump', {
              size: bytes(state.LIMITS.MAX_FILE_SIZE)
            })}
          </button>
        `;
  const uploadNotice = state.WEB_UI.UPLOAD_AREA_NOTICE_HTML
    ? html`
        <p
          class="w-full mt-8 p-2 border-default dark:border-grey-70 rounded-default text-orange-60 bg-yellow-40 text-center leading-normal"
        >
          ${raw(state.WEB_UI.UPLOAD_AREA_NOTICE_HTML)}
        </p>
      `
    : '';

  return html`
    <send-upload-area
      class="flex flex-col items-center justify-center border-2 border-dashed border-grey-transparent rounded-default px-6 py-16 h-full w-full dark:border-grey-60"
      onclick="${e => {
        if (e.target.tagName !== 'LABEL') {
          document.getElementById('file-upload').click();
        }
      }}"
    >
      <svg class="w-10 h-10">
        <use xlink:href="/${assets.get('addfiles.svg')}#plus" />
      </svg>
      <div class="pt-6 pb-2 text-center text-lg font-medium">
        ${state.translate('dragAndDropFiles')}
      </div>
      <div class="pb-6 text-center text-base">
        ${state.translate('orClickWithSize', {
          size: bytes(state.user.maxSize)
        })}
      </div>
      <input
        id="file-upload"
        class="opacity-0 w-0 h-0 appearance-none absolute overflow-hidden"
        type="file"
        multiple
        onfocus="${focus}"
        onblur="${blur}"
        onchange="${add}"
        onclick="${e => e.stopPropagation()}"
      />
      <div class="flex flex-col items-center mt-4">
        <label
          for="file-upload"
          role="button"
          class="btn rounded-lg flex items-center"
          title="${state.translate('addFilesButton', {
            size: bytes(state.user.maxSize)
          })}"
        >
          ${state.translate('addFilesButton')}
        </label>
      </div>
      ${upsell} ${uploadNotice}
    </send-upload-area>
  `;

  function focus(event) {
    event.target.nextElementSibling.classList.add('bg-primary', 'outline');
  }

  function blur(event) {
    event.target.nextElementSibling.classList.remove('bg-primary', 'outline');
  }

  function add(event) {
    event.preventDefault();
    const newFiles = Array.from(event.target.files);

    emit('addFiles', { files: newFiles });
  }
};

module.exports.preview = function(state, emit) {
  const archive = state.fileInfo;
  if (archive.open === undefined) {
    archive.open = true;
  }
  const single =
    archive.manifest && archive.manifest.files
      ? archive.manifest.files.length === 1
      : true;
  const details = single
    ? ''
    : html`
        <div class="mt-4 h-full md:h-48 overflow-y-auto">
          ${archiveDetails(state.translate, archive)}
        </div>
      `;
  const notice = state.WEB_UI.DOWNLOAD_NOTICE_HTML
    ? html`
        <p
          class="w-full mt-4 p-2 border-default dark:border-grey-70 rounded-default text-orange-60 bg-yellow-40 text-center leading-normal"
        >
          ${raw(state.WEB_UI.DOWNLOAD_NOTICE_HTML)}
        </p>
      `
    : '';
  const sponsor = state.WEB_UI.SHOW_THUNDERBIRD_SPONSOR
    ? html`
        <a
          class="w-full mt-5 mb-2 p-2 border-default dark:border-grey-70 rounded-default text-orange-60 bg-yellow-40 text-center leading-normal"
          href="https://www.thunderbird.net/"
        >
          <svg
            width="30"
            height="30"
            class="m-2 mr-3 d-inline-block align-middle"
          >
            <image
              xlink:href="${assets.get('thunderbird-icon.svg')}"
              src="${assets.get('thunderbird-icon.svg')}"
              width="30"
              height="30"
            />
          </svg>
          ${state.translate('sponsoredByThunderbird')}
        </a>
      `
    : '';

  const encryptionStatus =
    archive.encrypted !== false
      ? html`
          <div
            class="mt-2 text-sm text-green-60 dark:text-green-40 flex items-center"
          >
            <svg class="w-3 h-3 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path
                fill-rule="evenodd"
                d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
                clip-rule="evenodd"
              />
            </svg>
            ${state.translate('encryptionEnabled')}
          </div>
        `
      : html`
          <div
            class="mt-2 text-sm text-orange-60 dark:text-orange-40 flex items-center"
          >
            <svg class="w-3 h-3 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path
                fill-rule="evenodd"
                d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zM8 9V5.5a2 2 0 114 0V9H8z"
                clip-rule="evenodd"
              />
            </svg>
            ${state.translate('encryptionDisabled')}
          </div>
        `;

  return html`
    <send-archive
      class="flex flex-col max-h-full bg-white p-4 w-full md:w-128 dark:bg-grey-90"
    >
      <div class="border-default rounded-default py-3 px-6 dark:border-grey-70">
        ${archiveInfo(archive)} ${details}
      </div>
      ${encryptionStatus}
      <button
        id="download-btn"
        class="btn rounded-lg mt-8 w-full flex-shrink-0 focus:outline"
        title="${state.translate('downloadButtonLabel')}"
        onclick=${download}
      >
        ${state.translate('downloadButtonLabel')}
      </button>
      ${notice} ${sponsor}
    </send-archive>
  `;

  function download(event) {
    event.preventDefault();
    event.target.disabled = true;
    emit('download');
  }
};

module.exports.downloading = function(state) {
  const archive = state.fileInfo;
  const progress = state.transfer.progressRatio;
  const isInitializing = progress === 0 || progress === undefined;
  const progressPercent = isInitializing ? 'Preparing...' : percent(progress);
  return html`
    <send-archive
      class="flex flex-col bg-white rounded-default shadow-light p-4 w-full max-w-sm md:w-128 dark:bg-grey-90"
    >
      ${archiveInfo(archive)}
      <div class="link-primary text-sm font-medium mt-2">
        ${progressPercent}
      </div>
      <progress class="my-3" value="${isInitializing ? 0 : progress}"
        >${progressPercent}</progress
      >
    </send-archive>
  `;
};

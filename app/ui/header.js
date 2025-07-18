const html = require('choo/html');
const Component = require('choo/component');
const Account = require('./account');
const assets = require('../../common/assets');
const { platform } = require('../utils');

class Header extends Component {
  constructor(name, state, emit) {
    super(name);
    this.state = state;
    this.emit = emit;
    this.account = state.cache(Account, 'account');
  }

  update() {
    this.account.render();
    return false;
  }

  createElement() {
    let assetMap = {};
    if (this.state.ui !== undefined) assetMap = this.state.ui.assets;
    else
      assetMap = {
        icon:
          this.state.WEB_UI.CUSTOM_ASSETS.icon !== ''
            ? this.state.WEB_UI.CUSTOM_ASSETS.icon
            : assets.get('icon.svg'),
        wordmark:
          this.state.WEB_UI.CUSTOM_ASSETS.wordmark !== ''
            ? this.state.WEB_UI.CUSTOM_ASSETS.wordmark
            : assets.get('wordmark.svg') + '#logo'
      };
    const title =
      platform() === 'android'
        ? html`
            <a class="flex flex-row items-center">
              <svg
                height="32"
                width="32"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 45 45"
              >
                <defs>
                  <style>
                    .cls-1 {
                      fill: currentColor;
                    }
                  </style>
                </defs>
                <g id="Layer_2" data-name="Layer 2">
                  <g id="Layer_1-2" data-name="Layer 1">
                    <circle class="cls-1" cx="22.5" cy="22.5" r="2.5" />
                    <path
                      class="cls-1"
                      d="M22.5,0A22.5,22.5,0,0,0,6.59,38.41l3.54-3.54,3.53-3.53A12.51,12.51,0,0,0,22.52,35a12.1,12.1,0,0,0,1.21-.06l.56-.08.65-.1.63-.15.56-.15.6-.21.55-.2.55-.26a5.77,5.77,0,0,0,.56-.27c.18-.09.34-.2.51-.3l.54-.33c.19-.12.37-.26.55-.4l.43-.32a13.15,13.15,0,0,0,1.75-1.75l.32-.43c.14-.18.28-.36.41-.55s.21-.35.32-.53.21-.34.3-.52.18-.37.27-.56.18-.36.26-.55.13-.36.2-.55.15-.4.21-.6a5.73,5.73,0,0,0,.14-.56c.06-.21.12-.42.16-.63s.06-.43.1-.64.06-.38.08-.57A11.66,11.66,0,0,0,35,22.55V22.5a2.5,2.5,0,0,1,5,0h0a16.56,16.56,0,0,1-.09,1.73c0,.26-.07.51-.11.77s-.08.62-.14.92-.14.58-.21.87-.13.53-.2.79-.2.56-.3.84-.18.52-.28.78-.24.5-.36.76-.24.53-.38.79-.28.47-.42.71-.29.51-.46.76-.37.5-.55.75-.3.42-.47.62A17.58,17.58,0,0,1,33.59,36c-.2.17-.41.31-.62.47s-.49.38-.75.55-.51.31-.76.46-.47.29-.71.42-.53.26-.79.38l-.76.36-.78.28-.84.3-.79.2c-.29.07-.58.15-.87.21s-.61.1-.92.14-.51.09-.77.11A16.56,16.56,0,0,1,22.5,40h0a17.49,17.49,0,0,1-8.32-2.11l-.52.52-3.13,3.14A22.5,22.5,0,1,0,22.5,0ZM10,22.5a2.5,2.5,0,0,1-5,0A17.5,17.5,0,0,1,22.5,5a2.5,2.5,0,0,1,0,5A12.5,12.5,0,0,0,10,22.5ZM22.5,30A7.5,7.5,0,1,1,30,22.5,7.5,7.5,0,0,1,22.5,30Z"
                    />
                  </g>
                </g>
              </svg>

              <!--<svg class="w-48">
                <use xlink:href="${assetMap.wordmark}" />
              </svg>-->
            </a>
          `
        : html`
            <a class="flex flex-row items-center" href="/">
              <svg
                height="32"
                width="32"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 45 45"
              >
                <defs>
                  <style>
                    .cls-1 {
                      fill: currentColor;
                    }
                  </style>
                </defs>
                <g id="Layer_2" data-name="Layer 2">
                  <g id="Layer_1-2" data-name="Layer 1">
                    <circle class="cls-1" cx="22.5" cy="22.5" r="2.5" />
                    <path
                      class="cls-1"
                      d="M22.5,0A22.5,22.5,0,0,0,6.59,38.41l3.54-3.54,3.53-3.53A12.51,12.51,0,0,0,22.52,35a12.1,12.1,0,0,0,1.21-.06l.56-.08.65-.1.63-.15.56-.15.6-.21.55-.2.55-.26a5.77,5.77,0,0,0,.56-.27c.18-.09.34-.2.51-.3l.54-.33c.19-.12.37-.26.55-.4l.43-.32a13.15,13.15,0,0,0,1.75-1.75l.32-.43c.14-.18.28-.36.41-.55s.21-.35.32-.53.21-.34.3-.52.18-.37.27-.56.18-.36.26-.55.13-.36.2-.55.15-.4.21-.6a5.73,5.73,0,0,0,.14-.56c.06-.21.12-.42.16-.63s.06-.43.1-.64.06-.38.08-.57A11.66,11.66,0,0,0,35,22.55V22.5a2.5,2.5,0,0,1,5,0h0a16.56,16.56,0,0,1-.09,1.73c0,.26-.07.51-.11.77s-.08.62-.14.92-.14.58-.21.87-.13.53-.2.79-.2.56-.3.84-.18.52-.28.78-.24.5-.36.76-.24.53-.38.79-.28.47-.42.71-.29.51-.46.76-.37.5-.55.75-.3.42-.47.62A17.58,17.58,0,0,1,33.59,36c-.2.17-.41.31-.62.47s-.49.38-.75.55-.51.31-.76.46-.47.29-.71.42-.53.26-.79.38l-.76.36-.78.28-.84.3-.79.2c-.29.07-.58.15-.87.21s-.61.1-.92.14-.51.09-.77.11A16.56,16.56,0,0,1,22.5,40h0a17.49,17.49,0,0,1-8.32-2.11l-.52.52-3.13,3.14A22.5,22.5,0,1,0,22.5,0ZM10,22.5a2.5,2.5,0,0,1-5,0A17.5,17.5,0,0,1,22.5,5a2.5,2.5,0,0,1,0,5A12.5,12.5,0,0,0,10,22.5ZM22.5,30A7.5,7.5,0,1,1,30,22.5,7.5,7.5,0,0,1,22.5,30Z"
                    />
                  </g>
                </g>
              </svg>
              <!--<svg viewBox="66 0 340 64" class="w-48 md:w-64">
                <use xlink:href="${assetMap.wordmark}" />
              </svg>-->
            </a>
          `;
    return html`
      <header
        class="main-header relative flex-none flex flex-row items-center justify-between w-full px-6 md:px-8 h-16 md:h-24 z-20 bg-transparent"
      >
        ${title} ${this.account.render()}
      </header>
    `;
  }
}

module.exports = Header;

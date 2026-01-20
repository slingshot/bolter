import React from 'react';

export function Footer() {
  return (
    <footer className="w-full pb-6">
      <div className="max-w-container mx-auto px-6 flex flex-col gap-6 items-center">
        {/* Powered by Section */}
        <div className="flex flex-col items-center gap-5">
          <div className="flex flex-col items-center gap-1">
            <p className="text-paragraph-xxs text-content-tertiary">Powered by</p>
            <div className="h-4 w-[84.628px]">
              {/* Slingshot logo SVG */}
              <img src="/logo-white.svg" alt="Slingshot Logo" className="h-full" />
            </div>
          </div>
          <p className="text-paragraph-xxs text-content-secondary text-center">
            Modern business management for artists & creatives
          </p>
        </div>

        {/* Divider */}
        <div className="w-full h-[0.5px] bg-content-primary opacity-20" />

        {/* Footer Links */}
        <div className="w-full flex items-center justify-between text-paragraph-xxs text-content-secondary font-medium">
          <div className="flex items-center gap-5">
            <a href="/terms" className="hover:text-content-primary transition-colors">
              Terms
            </a>
            <a href="/privacy" className="hover:text-content-primary transition-colors">
              Privacy
            </a>
          </div>
          <div className="flex items-center gap-5">
            <a href="/cli" className="hover:text-content-primary transition-colors">
              CLI
            </a>
            <a href="/dmca" className="hover:text-content-primary transition-colors">
              DMCA
            </a>
            <a href="/source" className="hover:text-content-primary transition-colors">
              Source
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

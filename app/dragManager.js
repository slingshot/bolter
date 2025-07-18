// Helper function to recursively read all files from a directory entry
async function getAllFilesFromEntry(entry) {
  const files = [];

  if (entry.isFile) {
    // It's a file, wrap it in a promise
    return new Promise((resolve, reject) => {
      entry.file(resolve, reject);
    }).then(file => [file]);
  } else if (entry.isDirectory) {
    // It's a directory, read its contents
    const dirReader = entry.createReader();

    return new Promise((resolve, reject) => {
      const readEntries = () => {
        dirReader.readEntries(async entries => {
          if (entries.length === 0) {
            // No more entries, resolve with collected files
            resolve(files);
          } else {
            // Process each entry recursively
            for (const childEntry of entries) {
              const childFiles = await getAllFilesFromEntry(childEntry);
              files.push(...childFiles);
            }
            // Continue reading (directories might have more entries)
            readEntries();
          }
        }, reject);
      };
      readEntries();
    });
  }

  return files;
}

export default function(state, emitter) {
  emitter.on('DOMContentLoaded', () => {
    document.body.addEventListener('dragover', event => {
      if (state.route === '/') {
        event.preventDefault();
      }
    });
    document.body.addEventListener('drop', async event => {
      if (state.route === '/' && !state.uploading && event.dataTransfer) {
        event.preventDefault();

        // Handle both files and directories
        const files = [];

        if (event.dataTransfer.items) {
          // Use DataTransferItem API to handle both files and folders
          const items = Array.from(event.dataTransfer.items);
          for (const item of items) {
            if (item.kind === 'file') {
              const entry = item.webkitGetAsEntry();
              if (entry) {
                const entryFiles = await getAllFilesFromEntry(entry);
                files.push(...entryFiles);
              }
            }
          }
        } else if (
          event.dataTransfer.files &&
          event.dataTransfer.files.length > 0
        ) {
          // Fallback to files API (for older browsers)
          files.push(...Array.from(event.dataTransfer.files));
        }

        if (files.length > 0) {
          emitter.emit('addFiles', { files });
        }
      }
    });
  });
}

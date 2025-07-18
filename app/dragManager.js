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

        console.log('DEBUG: Drop event triggered');
        console.log(
          'DEBUG: dataTransfer.items:',
          event.dataTransfer.items ? event.dataTransfer.items.length : 'null'
        );
        console.log(
          'DEBUG: dataTransfer.files:',
          event.dataTransfer.files ? event.dataTransfer.files.length : 'null'
        );

        // Handle both files and directories
        const files = [];

        if (event.dataTransfer.items) {
          // Use DataTransferItem API to handle both files and folders
          const items = Array.from(event.dataTransfer.items);
          console.log('DEBUG: Processing', items.length, 'items');

          // Check if we have any directories (folders)
          let hasDirectories = false;
          for (const item of items) {
            if (item.kind === 'file') {
              const entry = item.webkitGetAsEntry();
              if (entry && entry.isDirectory) {
                hasDirectories = true;
                break;
              }
            }
          }

          console.log('DEBUG: Has directories:', hasDirectories);

          if (hasDirectories) {
            // If we have directories, use the entry API
            for (let i = 0; i < items.length; i++) {
              const item = items[i];
              console.log(
                `DEBUG: Item ${i}: kind=${item.kind}, type=${item.type}`
              );

              if (item.kind === 'file') {
                const entry = item.webkitGetAsEntry();
                console.log(
                  `DEBUG: Item ${i} entry:`,
                  entry ? (entry.isFile ? 'file' : 'directory') : 'null'
                );

                if (entry) {
                  try {
                    const entryFiles = await getAllFilesFromEntry(entry);
                    console.log(
                      `DEBUG: Item ${i} produced ${entryFiles.length} files`
                    );
                    files.push(...entryFiles);
                  } catch (e) {
                    console.log(`DEBUG: Item ${i} entry processing failed:`, e);
                    // If entry processing fails, fall back to direct file access
                    const file = item.getAsFile();
                    if (file) {
                      console.log(`DEBUG: Item ${i} fallback file:`, file.name);
                      files.push(file);
                    }
                  }
                } else {
                  // If no entry, fall back to direct file access
                  const file = item.getAsFile();
                  if (file) {
                    console.log(`DEBUG: Item ${i} direct file:`, file.name);
                    files.push(file);
                  }
                }
              }
            }
          } else {
            // No directories, use the simpler files API for better reliability
            console.log('DEBUG: Using files API for multiple files');
            if (
              event.dataTransfer.files &&
              event.dataTransfer.files.length > 0
            ) {
              files.push(...Array.from(event.dataTransfer.files));
            }
          }
        }

        // Always fall back to files API if we didn't get any files from items
        if (
          files.length === 0 &&
          event.dataTransfer.files &&
          event.dataTransfer.files.length > 0
        ) {
          console.log('DEBUG: Using files API fallback');
          files.push(...Array.from(event.dataTransfer.files));
        }

        console.log('DEBUG: Final files array:', files.length, 'files');
        files.forEach((file, i) => {
          console.log(`DEBUG: File ${i}: ${file.name} (${file.size} bytes)`);
        });

        if (files.length > 0) {
          emitter.emit('addFiles', { files });
        }
      }
    });
  });
}

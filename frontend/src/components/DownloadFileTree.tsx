import React, { useState, useMemo } from 'react';
import {
  File,
  FileText,
  Image,
  Video,
  Music,
  Archive,
  Folder,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { cn, formatBytes } from '@/lib/utils';

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  image: Image,
  video: Video,
  audio: Music,
  text: FileText,
  archive: Archive,
  default: File,
};

function getFileIcon(type: string) {
  if (type.startsWith('image/')) return iconMap.image;
  if (type.startsWith('video/')) return iconMap.video;
  if (type.startsWith('audio/')) return iconMap.audio;
  if (type.startsWith('text/') || type.includes('pdf')) return iconMap.text;
  if (type.includes('zip') || type.includes('tar') || type.includes('archive'))
    return iconMap.archive;
  return iconMap.default;
}

interface FileInfo {
  name: string;
  size: number;
  type: string;
}

// Tree node structure for hierarchical display
interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  children: Map<string, TreeNode>;
  files: FileInfo[];
  totalSize: number;
  totalFiles: number;
}

// Build a tree structure from flat file list
function buildFileTree(files: FileInfo[]): TreeNode {
  const root: TreeNode = {
    name: '',
    path: '',
    isFolder: true,
    children: new Map(),
    files: [],
    totalSize: 0,
    totalFiles: 0,
  };

  for (const file of files) {
    const fileName = file.name;
    const parts = fileName.split('/');

    // If no path separator, it's a root-level file
    if (parts.length === 1) {
      root.files.push(file);
      root.totalSize += file.size;
      root.totalFiles += 1;
      continue;
    }

    // Navigate/create the folder structure
    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const folderName = parts[i];
      const folderPath = parts.slice(0, i + 1).join('/');

      if (!current.children.has(folderName)) {
        current.children.set(folderName, {
          name: folderName,
          path: folderPath,
          isFolder: true,
          children: new Map(),
          files: [],
          totalSize: 0,
          totalFiles: 0,
        });
      }

      current = current.children.get(folderName)!;
    }

    // Add the file to the deepest folder (with just the filename, not full path)
    const fileInFolder: FileInfo = {
      ...file,
      name: parts[parts.length - 1],
    };
    current.files.push(fileInFolder);

    // Update totals up the tree
    let node: TreeNode | null = root;
    for (let i = 0; i < parts.length - 1; i++) {
      node.totalSize += file.size;
      node.totalFiles += 1;
      node = node.children.get(parts[i]) || null;
      if (!node) break;
    }
    if (node) {
      node.totalSize += file.size;
      node.totalFiles += 1;
    }
  }

  return root;
}

// Collect all folder paths for auto-expand
function collectAllFolderPaths(node: TreeNode): Set<string> {
  const paths = new Set<string>();
  for (const child of node.children.values()) {
    paths.add(child.path);
    const childPaths = collectAllFolderPaths(child);
    childPaths.forEach((p) => paths.add(p));
  }
  return paths;
}

interface FileRowProps {
  file: FileInfo;
  depth: number;
}

function FileRow({ file, depth }: FileRowProps) {
  const Icon = getFileIcon(file.type);

  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-overlay-medium"
      style={{ paddingLeft: `${8 + depth * 16}px` }}
    >
      <Icon className="h-4 w-4 text-content-secondary shrink-0" />
      <span className="truncate text-paragraph-xs text-content-primary flex-1">
        {file.name}
      </span>
      <span className="text-paragraph-xs text-content-tertiary shrink-0">
        {formatBytes(file.size)}
      </span>
    </div>
  );
}

interface FolderRowProps {
  node: TreeNode;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
}

function FolderRow({ node, depth, expanded, onToggle }: FolderRowProps) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-overlay-medium cursor-pointer"
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      onClick={onToggle}
    >
      <Folder className="h-4 w-4 text-content-secondary shrink-0" />
      <div className="flex items-center gap-1 flex-1 min-w-0">
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-content-tertiary shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-content-tertiary shrink-0" />
        )}
        <span className="truncate text-paragraph-xs text-content-primary font-medium">
          {node.name}
        </span>
      </div>
      <span className="text-paragraph-xs text-content-tertiary shrink-0">
        {node.totalFiles} {node.totalFiles === 1 ? 'file' : 'files'}
      </span>
    </div>
  );
}

interface TreeViewProps {
  node: TreeNode;
  depth: number;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
}

function TreeView({
  node,
  depth,
  expandedFolders,
  onToggleFolder,
}: TreeViewProps) {
  // Sort children alphabetically
  const sortedChildren = Array.from(node.children.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  // Sort files alphabetically
  const sortedFiles = [...node.files].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return (
    <>
      {/* Render subfolders */}
      {sortedChildren.map((child) => {
        const isExpanded = expandedFolders.has(child.path);

        return (
          <React.Fragment key={`folder-${child.path}`}>
            <FolderRow
              node={child}
              depth={depth}
              expanded={isExpanded}
              onToggle={() => onToggleFolder(child.path)}
            />
            {isExpanded && (
              <TreeView
                node={child}
                depth={depth + 1}
                expandedFolders={expandedFolders}
                onToggleFolder={onToggleFolder}
              />
            )}
          </React.Fragment>
        );
      })}

      {/* Render files in this folder */}
      {sortedFiles.map((file, index) => (
        <FileRow key={`file-${index}-${file.name}`} file={file} depth={depth} />
      ))}
    </>
  );
}

interface DownloadFileTreeProps {
  files: FileInfo[];
  className?: string;
}

export function DownloadFileTree({ files, className }: DownloadFileTreeProps) {
  // Build tree structure from files
  const tree = useMemo(() => buildFileTree(files), [files]);

  // Check if we have any folder structure
  const hasFolders = tree.children.size > 0;

  // Initialize with all folders expanded
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    return collectAllFolderPaths(tree);
  });

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // If no folder structure, render flat list
  if (!hasFolders) {
    return (
      <div className={cn('space-y-0.5', className)}>
        {files.map((file, index) => (
          <FileRow key={index} file={file} depth={0} />
        ))}
      </div>
    );
  }

  // Render hierarchical tree
  return (
    <div className={cn('space-y-0.5', className)}>
      <TreeView
        node={tree}
        depth={0}
        expandedFolders={expandedFolders}
        onToggleFolder={toggleFolder}
      />
    </div>
  );
}

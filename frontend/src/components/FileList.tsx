import React, { useState, useMemo } from 'react';
import {
  X,
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
import { Button } from '@/components/ui/button';
import { cn, formatBytes } from '@/lib/utils';
import { useAppStore, type FileItem } from '@/stores/app';

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

// Tree node structure for hierarchical display
interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  children: Map<string, TreeNode>;
  files: FileItem[];
  totalSize: number;
  totalFiles: number;
}

// Build a tree structure from flat file list
function buildFileTree(files: FileItem[]): TreeNode {
  const root: TreeNode = {
    name: '',
    path: '',
    isFolder: true,
    children: new Map(),
    files: [],
    totalSize: 0,
    totalFiles: 0,
  };

  for (const fileItem of files) {
    const fileName = fileItem.file.name;
    const parts = fileName.split('/');

    // If no path separator, it's a root-level file
    if (parts.length === 1) {
      root.files.push(fileItem);
      root.totalSize += fileItem.file.size;
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

    // Add the file to the deepest folder
    current.files.push(fileItem);

    // Update totals up the tree
    let node: TreeNode | null = root;
    for (let i = 0; i < parts.length - 1; i++) {
      node.totalSize += fileItem.file.size;
      node.totalFiles += 1;
      node = node.children.get(parts[i]) || null;
      if (!node) break;
    }
    if (node) {
      node.totalSize += fileItem.file.size;
      node.totalFiles += 1;
    }
  }

  return root;
}

// Get display name (last part of path)
function getDisplayName(fileName: string): string {
  const parts = fileName.split('/');
  return parts[parts.length - 1];
}

// Collect all file IDs under a folder
function collectFileIds(node: TreeNode): string[] {
  const ids: string[] = [];

  for (const file of node.files) {
    ids.push(file.id);
  }

  for (const child of node.children.values()) {
    ids.push(...collectFileIds(child));
  }

  return ids;
}

interface FileRowProps {
  item: FileItem;
  depth: number;
  isUploading: boolean;
  onRemove: (id: string) => void;
}

function FileRow({ item, depth, isUploading, onRemove }: FileRowProps) {
  const Icon = getFileIcon(item.file.type);
  const displayName = getDisplayName(item.file.name);

  return (
    <div
      className={cn(
        'flex items-center gap-[10px] py-2',
        item.status === 'error' && 'opacity-50'
      )}
      style={{ paddingLeft: `${depth * 20}px` }}
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-overlay-medium">
        <Icon className="h-4 w-4 text-content-secondary" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-paragraph-xs text-content-primary font-medium leading-[1.5]">
          {displayName}
        </p>
        <p className="text-paragraph-xxs text-content-tertiary">
          {formatBytes(item.file.size)}
        </p>
      </div>

      {item.status === 'uploading' && (
        <div className="h-1 w-16 overflow-hidden rounded-full bg-overlay-medium">
          <div
            className="h-full bg-content-primary transition-all"
            style={{ width: `${item.progress}%` }}
          />
        </div>
      )}

      {item.status === 'error' && (
        <span className="text-paragraph-xxs text-red-600">{item.error}</span>
      )}

      {!isUploading && (
        <Button
          variant="ghost"
          size="icon"
          className="h-[18px] w-[18px] shrink-0 p-0"
          onClick={() => onRemove(item.id)}
        >
          <X className="h-[18px] w-[18px] text-content-primary" />
        </Button>
      )}
    </div>
  );
}

interface FolderRowProps {
  node: TreeNode;
  depth: number;
  isUploading: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRemoveFolder: (fileIds: string[]) => void;
}

function FolderRow({
  node,
  depth,
  isUploading,
  expanded,
  onToggle,
  onRemoveFolder,
}: FolderRowProps) {
  const handleRemove = () => {
    const fileIds = collectFileIds(node);
    onRemoveFolder(fileIds);
  };

  return (
    <div
      className="flex items-center gap-2 py-2 cursor-pointer hover:bg-overlay-subtle rounded transition-colors"
      style={{ paddingLeft: `${depth * 20}px` }}
      onClick={onToggle}
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-overlay-medium">
        <Folder className="h-4 w-4 text-content-secondary" />
      </div>

      <div className="flex items-center gap-1 min-w-0 flex-1">
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-content-secondary shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-content-secondary shrink-0" />
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-paragraph-xs text-content-primary font-medium leading-[1.5]">
            {node.name}
          </p>
          <p className="text-paragraph-xxs text-content-tertiary">
            {node.totalFiles} {node.totalFiles === 1 ? 'file' : 'files'} •{' '}
            {formatBytes(node.totalSize)}
          </p>
        </div>
      </div>

      {!isUploading && (
        <Button
          variant="ghost"
          size="icon"
          className="h-[18px] w-[18px] shrink-0 p-0"
          onClick={(e) => {
            e.stopPropagation();
            handleRemove();
          }}
        >
          <X className="h-[18px] w-[18px] text-content-primary" />
        </Button>
      )}
    </div>
  );
}

interface TreeViewProps {
  node: TreeNode;
  depth: number;
  isUploading: boolean;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onRemoveFile: (id: string) => void;
  onRemoveFolder: (fileIds: string[]) => void;
}

function TreeView({
  node,
  depth,
  isUploading,
  expandedFolders,
  onToggleFolder,
  onRemoveFile,
  onRemoveFolder,
}: TreeViewProps) {
  // Sort children: folders first, then alphabetically
  const sortedChildren = Array.from(node.children.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  // Sort files alphabetically by display name
  const sortedFiles = [...node.files].sort((a, b) =>
    getDisplayName(a.file.name).localeCompare(getDisplayName(b.file.name))
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
              isUploading={isUploading}
              expanded={isExpanded}
              onToggle={() => onToggleFolder(child.path)}
              onRemoveFolder={onRemoveFolder}
            />
            {isExpanded && (
              <TreeView
                node={child}
                depth={depth + 1}
                isUploading={isUploading}
                expandedFolders={expandedFolders}
                onToggleFolder={onToggleFolder}
                onRemoveFile={onRemoveFile}
                onRemoveFolder={onRemoveFolder}
              />
            )}
          </React.Fragment>
        );
      })}

      {/* Render files in this folder */}
      {sortedFiles.map((item) => (
        <FileRow
          key={item.id}
          item={item}
          depth={depth}
          isUploading={isUploading}
          onRemove={onRemoveFile}
        />
      ))}
    </>
  );
}

export function FileList() {
  const { files, removeFile, isUploading } = useAppStore();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set()
  );

  // Build tree structure from files
  const tree = useMemo(() => buildFileTree(files), [files]);

  // Check if we have any folder structure
  const hasFolders = tree.children.size > 0;

  // Auto-expand all folders on initial load
  useMemo(() => {
    if (hasFolders) {
      const allFolderPaths = new Set<string>();
      const collectPaths = (node: TreeNode) => {
        for (const child of node.children.values()) {
          allFolderPaths.add(child.path);
          collectPaths(child);
        }
      };
      collectPaths(tree);
      setExpandedFolders(allFolderPaths);
    }
  }, [hasFolders, tree.children.size]);

  if (files.length === 0) return null;

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

  const handleRemoveFolder = (fileIds: string[]) => {
    for (const id of fileIds) {
      removeFile(id);
    }
  };

  // If no folder structure, render flat list
  if (!hasFolders) {
    return (
      <div className="flex flex-col divide-y-[0.5px] divide-border-medium">
        {files.map((item) => (
          <FileRow
            key={item.id}
            item={item}
            depth={0}
            isUploading={isUploading}
            onRemove={removeFile}
          />
        ))}
      </div>
    );
  }

  // Render hierarchical tree
  return (
    <div className="flex flex-col divide-y-[0.5px] divide-border-medium">
      <TreeView
        node={tree}
        depth={0}
        isUploading={isUploading}
        expandedFolders={expandedFolders}
        onToggleFolder={toggleFolder}
        onRemoveFile={removeFile}
        onRemoveFolder={handleRemoveFolder}
      />
    </div>
  );
}

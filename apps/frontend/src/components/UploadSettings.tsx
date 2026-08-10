import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { formatDownloadLimit, formatTimeLimit } from '@/lib/utils';
import { useAppStore } from '@/stores/app';

/** Return `options` with `active` merged in (sorted ascending) if it is missing. */
export function withActiveValue(options: number[], active: number): number[] {
    if (options.includes(active)) {
        return options;
    }
    return [...options, active].sort((a, b) => a - b);
}

export function UploadSettings() {
    const {
        encrypted,
        setEncrypted,
        timeLimit,
        setTimeLimit,
        downloadLimit,
        setDownloadLimit,
        config,
    } = useAppStore();

    // A Select renders blank when its value has no matching item — which happens
    // whenever the configured default (or a previously chosen value) is not in
    // the admin's option list. Always include the active value.
    const expireTimes = withActiveValue(
        config?.expireTimes || [300, 3600, 86400, 604800],
        timeLimit,
    );
    const downloadCounts = withActiveValue(
        config?.downloadCounts || [1, 2, 3, 4, 5, 20, 50, 100],
        downloadLimit,
    );

    return (
        <div className="flex flex-col gap-3">
            {/* Encryption Toggle */}
            <div className="flex h-[34px] items-center">
                <Toggle
                    checked={encrypted}
                    onCheckedChange={setEncrypted}
                    label="Encrypt files for enhanced security"
                />
            </div>

            {/* Divider */}
            <div className="h-[0.5px] bg-border-medium" />

            {/* Time and Download Limits */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <Toggle
                    checked={true}
                    onCheckedChange={() => {
                        /* always enabled */
                    }}
                    label="Expires after"
                />
                <div className="flex flex-1 items-center gap-2">
                    <Select
                        value={String(downloadLimit)}
                        onValueChange={(v) => setDownloadLimit(parseInt(v, 10))}
                    >
                        <SelectTrigger className="flex-1">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {downloadCounts.map((count) => (
                                <SelectItem key={count} value={String(count)}>
                                    {formatDownloadLimit(count)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <span className="text-paragraph-xs text-content-primary font-medium">or</span>
                    <Select
                        value={String(timeLimit)}
                        onValueChange={(v) => setTimeLimit(parseInt(v, 10))}
                    >
                        <SelectTrigger className="flex-1">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {expireTimes.map((time) => (
                                <SelectItem key={time} value={String(time)}>
                                    {formatTimeLimit(time)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>
        </div>
    );
}

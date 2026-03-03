import type { UserConfig } from '@commitlint/types';

const config: UserConfig = {
    extends: ['@commitlint/config-conventional'],
    rules: {
        'scope-enum': [
            2,
            'always',
            ['frontend', 'backend', 'shared', 'deps', 'ci', 'docker', 'release'],
        ],
        'scope-empty': [1, 'never'],
    },
};

export default config;

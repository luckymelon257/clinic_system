import reactHooks from 'eslint-plugin-react-hooks';
import root from '../../eslint.config.js';

export default [...root, { files: ['**/*.{ts,tsx}'], plugins: { 'react-hooks': reactHooks }, rules: reactHooks.configs.recommended.rules }];

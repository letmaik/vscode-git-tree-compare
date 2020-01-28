import * as path from 'path';

export function normalizePath(p: string) {
    p = path.normalize(p);
    
	if (process.platform === 'win32') {
        // normalize drive letter only, assuming rest is identical
        if (path.isAbsolute(p)) {
            p = p.substr(0, 1).toLowerCase() + p.substr(1)
        }
	}

	return p;
}
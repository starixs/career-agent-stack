"""One-shot migration: rewrite keystone theme token names to the career design tokens.

Run from app/shell:  python3 -I scripts/design/rename-tokens.py src/renderer
Every `--name` occurrence is looked up as a whole token, so `--paper` and
`--paper-elevated` never collide even though one is a prefix of the other.
"""
import os
import re
import sys

MAPPING = {
    # surfaces
    '--paper': '--bg',
    '--paper-elevated': '--paper',
    '--paper-inset': '--inset',
    '--global-sidebar-bg': '--rail',
    '--message-user-bg': '--note',
    '--paper-a0': '--bg-a0',
    '--paper-elevated-a0': '--paper-a0',
    '--paper-inset-a0': '--inset-a0',
    '--global-sidebar-bg-a0': '--rail-a0',
    '--message-user-bg-a0': '--note-a0',
    '--hover-bg': '--hover',
    # text
    '--ink-secondary': '--ink-2',
    '--ink-muted': '--muted',
    '--ink-subtle': '--subtle',
    '--ink-faint': '--subtle',
    # lines
    '--line-strong': '--line-2',
    '--line-subtle': '--line',
    '--expanded-block-line': '--line-2',
    '--toggle-off-bg': '--line-2',
    # brand / actions
    '--accent': '--primary',
    '--accent-warm': '--primary',
    '--accent-warm-hover': '--primary-hover',
    '--accent-warm-subtle': '--primary-soft',
    '--accent-warm-muted': '--primary-muted',
    '--accent-warm-subtle-a0': '--primary-soft-a0',
    '--accent-cool': '--info',
    '--accent-cool-hover': '--info',
    '--on-accent': '--on-primary',
    '--focus-border': '--primary',
    '--button-primary-bg': '--primary',
    '--button-primary-bg-hover': '--primary-hover',
    '--button-primary-text': '--on-primary',
    '--button-dark-bg': '--ink',
    '--button-dark-bg-hover': '--ink-2',
    '--button-dark-text': '--bg',
    '--button-secondary-bg': '--paper',
    '--button-secondary-bg-hover': '--hover',
    '--button-secondary-text': '--ink',
    # status
    '--error': '--danger',
    '--error-bg': '--danger-bg',
    '--error-hover': '--danger',
    '--error-subtle': '--danger-bg',
    '--on-error': '--on-primary',
    '--on-success': '--on-primary',
    '--on-warning': '--on-primary',
    '--on-info': '--on-primary',
    '--warning-border': '--warning',
    '--heartbeat': '--success',
    '--heartbeat-bg': '--success-bg',
    '--heartbeat-border': '--success',
    # media controls
    '--media-control-bg': '--ink',
    '--media-control-text': '--bg',
    '--media-control-accent': '--primary',
    '--media-stop-bg': '--danger',
    '--media-stop-text': '--on-primary',
    # code
    '--code-bg': '--inset',
    '--code-bg-a0': '--inset-a0',
    '--code-header-bg': '--selected',
    '--code-text': '--ink-2',
    '--code-line-number': '--subtle',
    # material that has no place in the new system
    '--featured-card-background': '--paper',
    '--featured-card-border': '--line-2',
    '--featured-card-shadow': '--shadow-xs',
    '--action-shadow': '--shadow-xs',
    '--action-shadow-active': '--shadow-xs',
    '--tool-shadow': '--shadow-sm',
    '--tool-shadow-hover': '--shadow-md',
    # fonts and motion
    '--font-body': '--font-sans',
    '--font-display': '--font-human',
    '--font-code': '--font-mono',
    '--duration-fast': '--motion-fast',
    '--duration-normal': '--motion-base',
    '--duration-slow': '--motion-slow',
}

TOKEN = re.compile(r'--[a-z][a-z0-9-]*')
EXTENSIONS = ('.ts', '.tsx', '.css', '.js', '.jsx')


def rewrite(text: str) -> str:
    return TOKEN.sub(lambda m: MAPPING.get(m.group(0), m.group(0)), text)


def main(roots: list[str]) -> None:
    changed = 0
    for root in roots:
        for directory, _, files in os.walk(root):
            if 'node_modules' in directory:
                continue
            for name in files:
                if not name.endswith(EXTENSIONS):
                    continue
                path = os.path.join(directory, name)
                with open(path, encoding='utf-8') as handle:
                    original = handle.read()
                updated = rewrite(original)
                if updated != original:
                    with open(path, 'w', encoding='utf-8') as handle:
                        handle.write(updated)
                    changed += 1
    print(f'rewrote {changed} files')


if __name__ == '__main__':
    main(sys.argv[1:])

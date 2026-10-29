"""Extract static task HTML text, optionally limited to one stable ID."""
from argparse import ArgumentParser
from html.parser import HTMLParser
from pathlib import Path
import sys


class TaskText(HTMLParser):
    void = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
            'link', 'meta', 'param', 'source', 'track', 'wbr'}
    blocks = {'p', 'div', 'section', 'article', 'header', 'footer', 'main',
              'h1', 'h2', 'h3', 'h4', 'li', 'tr', 'dt', 'dd', 'summary',
              'details', 'blockquote', 'pre'}

    def __init__(self, section=None):
        super().__init__(convert_charrefs=True)
        self.section = section
        self.stack = []
        self.lines = []
        self.matches = 0

    def visible(self):
        tags = [tag for tag, _, _ in self.stack]
        if any(tag in {'head', 'script', 'style', 'template'} for tag in tags):
            return False
        return any(selected for _, selected, _ in self.stack) if self.section else 'body' in tags

    def handle_starttag(self, tag, attrs):
        selected = bool(self.section and dict(attrs).get('id') == self.section)
        self.matches += int(selected)
        if tag not in self.void:
            self.stack.append((tag, selected, dict(attrs).get('href') if tag == 'a' else None))
        if self.visible():
            if tag in self.blocks or tag in {'br', 'hr'}:
                self.lines.append('\n')
            elif tag in {'td', 'th'}:
                self.lines.append(' | ')

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.void:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.visible() and tag in self.blocks:
            self.lines.append('\n')
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                if tag == 'a' and self.visible() and self.stack[i][2]:
                    self.lines.append(' [' + self.stack[i][2] + ']')
                del self.stack[i:]
                break

    def handle_data(self, data):
        if self.visible():
            self.lines.append(data)

    def text(self):
        return '\n'.join(line for raw in ''.join(self.lines).splitlines()
                         if (line := ' '.join(raw.split()).strip(' |')))


def main():
    args = ArgumentParser(description=__doc__)
    args.add_argument('page', type=Path)
    args.add_argument('--section', help='Exact HTML id; duplicate/missing IDs are errors')
    opts = args.parse_args()
    try:
        parser = TaskText(opts.section)
        parser.feed(opts.page.read_text(encoding='utf-8-sig'))
        parser.close()
        if opts.section and parser.matches != 1:
            raise ValueError(f'Expected one section {opts.section!r}, found {parser.matches}')
        result = parser.text()
        if not result:
            raise ValueError('No readable body text in the requested content')
    except (OSError, UnicodeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    print(result)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

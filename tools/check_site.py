#!/usr/bin/env python3
"""Check a static gallery and its public allowlist without changing any files."""
import json
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.refs = []
        self.tasks = []
        self.header_refs = []
        self.in_header = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'header':
            self.in_header = True
        if self.in_header and tag == 'a' and 'href' in attrs:
            self.header_refs.append(attrs['href'])
        if 'id' in attrs:
            self.ids.append(attrs['id'])
        if 'data-gallery-task' in attrs:
            self.tasks.append(attrs['data-gallery-task'])
        for key in ('src', 'href'):
            if key in attrs:
                self.refs.append(attrs[key])

    def handle_endtag(self, tag):
        if tag == 'header':
            self.in_header = False


def main():
    page = Page()
    html = (ROOT / 'index.html').read_text()
    page.feed(html)
    assert len(page.ids) == len(set(page.ids)), 'Duplicate HTML IDs'
    assert page.tasks == ['joint', 'newview', 'c2v', 'v2c']
    assert (page.ids.index('overview') < page.ids.index('dream4act')
            < page.ids.index('method') < page.ids.index('demos')), 'Incorrect introduction section order'
    assert '#dream4act' in page.header_refs, 'Missing Dream4ACT header navigation'
    for link in ('https://dream4act.github.io/', 'https://arxiv.org/abs/2609.40153',
                 'https://huggingface.co/papers/2609.40153'):
        assert link in page.refs, f'Missing Dream4ACT link: {link}'
    assert 'role="tab"' not in html and 'role="tabpanel"' not in html
    for ref in page.refs:
        if ref.startswith('#'):
            assert ref[1:] in page.ids, f'Broken anchor: {ref}'
        elif not ref.startswith(('https:', 'http:', 'mailto:')):
            assert (ROOT / ref).is_file(), f'Missing asset: {ref}'
    data = json.loads((ROOT / 'data/gallery.json').read_text())
    translations = json.loads((ROOT / 'data/prompts.zh.json').read_text())
    assert set(translations) == {case['id'] for case in data['cases']}, 'Missing or stale prompt translations'
    for case in data['cases']:
        translated = translations[case['id']]
        assert translated['en'] == case['prompt'], f'Stale translation: {case["id"]}'
        assert translated['zh'].strip() and any('\u4e00' <= c <= '\u9fff' for c in translated['zh'])
    assert html.index('assets/locale-zh.js') < html.index('assets/i18n.js') < html.index('assets/gallery.js')
    assert 'data-set-language="en"' in html and 'data-set-language="zh"' in html
    showcase = json.loads((ROOT / 'data/showcase.json').read_text())
    ordered = [entry for entries in showcase['tasks'].values() for entry in entries]
    assert [c['id'] for c in data['cases']] == [c['id'] for c in ordered]
    assert len(ordered) == len({entry['id'] for entry in ordered})
    allowed_case = {'id', 'task', 'title', 'prompt', 'streams', 'robot', 'dataset', 'environment'}
    allowed_stream = {'src', 'poster', 'posterTime', 'label', 'kind', 'modality', 'view',
                      'width', 'height', 'fps', 'frames', 'duration'}
    assets = set()
    for case, selected in zip(data['cases'], ordered):
        assert set(case) <= allowed_case, f'Unexpected public fields: {case["id"]}'
        for key in ('robot', 'dataset', 'environment'):
            assert case[key] == selected[key] and case[key]
        assert len({(s['frames'], s['fps']) for s in case['streams']}) == 1
        for stream in case['streams']:
            assert set(stream) <= allowed_stream
            for key in ('src', 'poster'):
                path = Path(stream[key])
                assert not path.is_absolute() and '..' not in path.parts
                assert path.parts[0] == 'media' and (ROOT / path).is_file()
                assets.add(path)
    assert all(token not in (ROOT / 'data/gallery.json').read_text()
               for token in ('/mnt/', '/Users/', 'selected_good', 'source_path', 'metadata_paths'))
    print(json.dumps({'cases': len(ordered),
                      'per_task': {k: len(v) for k, v in showcase['tasks'].items()},
                      'streams': sum(len(c['streams']) for c in data['cases']),
                      'selected_media_bytes': sum((ROOT / p).stat().st_size for p in assets),
                      'local_links_and_assets': 'passed', 'public_schema': 'passed',
                      'prompt_translations': len(translations)}))


if __name__ == '__main__':
    main()

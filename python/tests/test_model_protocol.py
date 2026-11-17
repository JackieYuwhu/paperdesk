"""Offline protocol and real translation/vision call-path regression tests."""
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.model_protocol import chat_endpoint, chat_payload, response_text
from app.model_auth import auth_headers
from app import translate, vision


class ProtocolTests(unittest.TestCase):
    def test_endpoints(self):
        self.assertEqual(chat_endpoint('https://relay.test/v1/messages'), 'https://relay.test/v1/messages')
        self.assertEqual(chat_endpoint('https://api.openai.com'), 'https://api.openai.com/v1/chat/completions')

    def test_system_and_images(self):
        body, headers = chat_payload('https://relay.test/v1/messages', {
            'model': 'test', 'temperature': 0, 'thinking': {'type': 'disabled'},
            'messages': [{'role': 'system', 'content': 'translate'}, {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AAAA'}}]}]
        }, auth_headers('https://relay.test/v1/messages', 'synthetic-key'))
        self.assertEqual(body['system'], 'translate')
        self.assertGreater(body['max_tokens'], 0)
        self.assertNotIn('temperature', body)
        self.assertNotIn('thinking', body)
        self.assertEqual(body['messages'][0]['content'][0]['source']['data'], 'AAAA')
        self.assertEqual(headers['anthropic-version'], '2023-06-01')
        self.assertNotIn('Authorization', headers)

    def test_translation_and_vision_dispatch(self):
        calls = []

        class Reply:
            status_code = 200
            text = ''

            def json(self):
                return {'content': [{'type': 'thinking', 'thinking': 'hidden'}, {'type': 'text', 'text': '译文'}]}

        def post(url, **kwargs):
            calls.append((url, kwargs))
            return Reply()

        with patch('app._http.post', side_effect=post):
            out = translate.translate_text('text', 'openai', 'zh', 'https://relay.test/v1/messages', 'synthetic-key', 'test')
            self.assertEqual(out, '译文')
            self.assertEqual(vision.chat_vision('https://relay.test/v1/messages', 'synthetic-key', 'test', {}, 'read', ['AAAA']), '译文')
        self.assertEqual(len(calls), 2)
        for url, request in calls:
            self.assertTrue(url.endswith('/v1/messages'))
            self.assertIn('max_tokens', request['json'])
            self.assertEqual(request['headers']['x-api-key'], 'synthetic-key')
            self.assertNotIn('Authorization', request['headers'])

    def test_openai_stays_compatible(self):
        original = {'model': 'test', 'messages': [{'role': 'user', 'content': 'hi'}], 'temperature': 0}
        body, _ = chat_payload('https://relay.test/v1/chat/completions', original, {})
        self.assertEqual(body, original)
        self.assertEqual(response_text({'choices': [{'message': {'content': 'ok'}}]}), 'ok')


if __name__ == '__main__':
    unittest.main()

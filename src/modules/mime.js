/**
 * Copyright (C) 2015-2018 Mailvelope GmbH
 * Licensed under the GNU Affero General Public License version 3
 */

import mvelo from '../lib/lib-mvelo';
import {html2text, encodeHTML, ab2str, byteCount, MvError, getHash} from '../lib/util';
import * as mailreader from '../lib/mail-reader';
import MimeBuilder from 'emailjs-mime-builder';

/**
 * Parse email content
 * @param  {String} rawText
 * @param  {Object<onAttachment, onMessage>} handlers
 * @param  {[type]} encoding 'html' or 'text'
 * @return {[type]}          [description]
 */
export async function parseMessage(rawText, handlers, encoding) {
  if (/^\s*(MIME-Version|Content-Type|Content-Transfer-Encoding|From|Date|Content-Language):/.test(rawText)) {
    await parseMIME(rawText, handlers, encoding);
  } else {
    await parseInline(rawText, handlers, encoding);
  }
}

function parseMIME(rawText, handlers, encoding) {
  return new Promise(resolve => {
    // mailreader expects rawText in pseudo-binary
    rawText = unescape(encodeURIComponent(rawText));
    mailreader.parse([{raw: rawText}], parsed => {
      if (parsed && parsed.length > 0) {
        const htmlParts = [];
        const textParts = [];
        if (encoding === 'html') {
          filterBodyParts(parsed, 'html', htmlParts);
          if (htmlParts.length) {
            const sanitized = mvelo.util.sanitizeHTML(htmlParts.map(part => part.content).join('\n<hr>\n'));
            handlers.onMessage(sanitized);
          } else {
            filterBodyParts(parsed, 'text', textParts);
            if (textParts.length) {
              handlers.onMessage(textParts.map(part => mvelo.util.text2autoLinkHtml(part.content)).join('<hr>'));
            }
          }
        } else if (encoding === 'text') {
          filterBodyParts(parsed, 'text', textParts);
          if (textParts.length) {
            handlers.onMessage(textParts.map(part => part.content).join('\n\n'));
          } else {
            filterBodyParts(parsed, 'html', htmlParts);
            if (htmlParts.length) {
              handlers.onMessage(htmlParts.map(part => html2text(part.content)).join('\n\n'));
            }
          }
        }
        const attachmentParts = [];
        filterBodyParts(parsed, 'attachment', attachmentParts);
        attachmentParts.forEach(part => {
          part.filename = encodeHTML(part.filename);
          part.content = ab2str(part.content.buffer);
          handlers.onAttachment(part);
        });
      }
      if (handlers.noEvent) {
        handlers.onMessage('');
      }
      resolve();
    });
  });
}

async function parseInline(rawText, handlers, encoding) {
  if (encoding === 'html') {
    handlers.onMessage(mvelo.util.text2autoLinkHtml(rawText));
  } else {
    if (/(<\/a>|<br>|<\/div>|<\/p>|<\/b>|<\/u>|<\/i>|<\/ul>|<\/li>)/.test(rawText)) {
      // legacy html mode
      handlers.onMessage(html2text(rawText));
    } else {
      // plain text
      handlers.onMessage(rawText);
    }
  }
}

// attribution: https://github.com/whiteout-io/mail-html5
function filterBodyParts(bodyParts, type, result) {
  result = result || [];
  bodyParts.forEach(part => {
    if (part.type === type) {
      result.push(part);
    } else if (Array.isArray(part.content)) {
      filterBodyParts(part.content, type, result);
    }
  });
  return result;
}

/**
 * @param {String} message
 * @param {Map} attachments
 * @param {String} attachments.filename
 * @param {String} attachments.content
 * @param {Integer} attachments.size
 * @param {String} attachments.type
 * @returns {String | null}
 */
export function buildMail({message, attachments, quota, pgpMIME}) {
  const mainMessage = new MimeBuilder('multipart/mixed');
  let composedMessage = null;
  let hasAttachment;
  let quotaSize = 0;
  if (message) {
    quotaSize += byteCount(message);
    const textMime = new MimeBuilder('text/plain')
    .setHeader({'content-transfer-encoding': 'quoted-printable'})
    .setContent(message);
    mainMessage.appendChild(textMime);
  }
  if (attachments && attachments.length > 0) {
    hasAttachment = true;
    for (const attachment of attachments) {
      quotaSize += attachment.size;
      const attachmentMime = new MimeBuilder('multipart/mixed')
      .createChild(null, {filename: attachment.name})
      .setHeader({
        'content-transfer-encoding': 'base64',
        'content-disposition': 'attachment'
      })
      .setContent(attachment.content);
      mainMessage.appendChild(attachmentMime);
    }
  }
  if (quota && (quotaSize > quota)) {
    throw new MvError('Mail content exceeds quota limit.', 'ENCRYPT_QUOTA_SIZE');
  }
  if (hasAttachment || pgpMIME) {
    composedMessage = mainMessage.build();
  } else {
    composedMessage = message;
  }
  return composedMessage;
}

export function buildPGPMail({armored, sender, to, cc, subject, quota}) {
  let quotaSize = 0;
  const mainMessage = new MimeBuilder('multipart/encrypted; protocol="application/pgp-encrypted";');
  const headers = {
    from: sender,
    to: to.join(', '),
    subject
  };
  if (cc) {
    headers.cc = cc.join(', ');
  }
  mainMessage.addHeader(headers);
  const mainContent = 'This is an OpenPGP/MIME encrypted message (RFC 2440 and 3156)';
  mainMessage.setContent(mainContent);
  quotaSize += byteCount(mainContent);
  const pgpHeader = new MimeBuilder('application/pgp-encrypted')
  .setHeader({'content-description': 'PGP/MIME version identification'});
  const pgpHeaderContent = 'Version: 1';
  pgpHeader.setContent(pgpHeaderContent);
  quotaSize += byteCount(pgpHeaderContent);
  mainMessage.appendChild(pgpHeader);
  const pgpArmored = new MimeBuilder('application/octet-stream; name="encrypted.asc"')
  .setHeader({
    'content-description': 'OpenPGP encrypted message',
    'content-disposition': 'inline; filename="encrypted.asc"'
  })
  .setContent(armored);
  quotaSize += byteCount(armored);
  mainMessage.appendChild(pgpArmored);
  if (quota && (quotaSize > quota)) {
    throw new MvError('Mail content exceeds quota limit.', 'ENCRYPT_QUOTA_SIZE');
  }
  return mainMessage.build();
}

export function buildTextMail({armored, sender, to, subject, quota}) {
  let quotaSize = 0;
  const mainMessage = new MimeBuilder('text/plain')
  .addHeader({
    from: sender,
    to: to.join(', '),
    subject
  });
  mainMessage.setContent(armored);
  quotaSize += byteCount(armored);
  if (quota && (quotaSize > quota)) {
    throw new MvError('Mail content exceeds quota limit.', 'ENCRYPT_QUOTA_SIZE');
  }
  return mainMessage.build();
}

export function buildMailWithHeader({message, attachments, sender, to, subject, quota}) {
  const mainMessage = new MimeBuilder('multipart/mixed')
  .addHeader({
    from: sender,
    to: to.join(', '),
    subject
  });
  let quotaSize = 0;
  if (message) {
    quotaSize += byteCount(message);
    const textMime = new MimeBuilder('text/plain')
    .setHeader({'content-transfer-encoding': 'quoted-printable'})
    .setContent(message);
    mainMessage.appendChild(textMime);
  }
  if (attachments && attachments.length > 0) {
    for (const attachment of attachments) {
      quotaSize += attachment.size;
      const id = `mv_${getHash()}`;
      const attachmentMime = new MimeBuilder('multipart/mixed')
      .createChild(null, {filename: attachment.name})
      .setHeader({
        'content-transfer-encoding': 'base64',
        'content-disposition': 'attachment',
        'X-Attachment-Id': id,
        'Content-ID': `<${id}>`
      })
      .setContent(attachment.content);
      mainMessage.appendChild(attachmentMime);
    }
  }
  if (quota && (quotaSize > quota)) {
    throw new MvError('Mail content exceeds quota limit.', 'ENCRYPT_QUOTA_SIZE');
  }
  return mainMessage.build();
}

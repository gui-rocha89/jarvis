// ============================================
// JARVIS 2.0 - Helpers (funções puras testáveis)
// ============================================

export function getMediaType(m) {
  if (!m.message) return null;
  if (m.message.audioMessage) return 'audio';
  if (m.message.imageMessage) return 'image';
  if (m.message.videoMessage) return 'video';
  if (m.message.documentMessage) return 'document';
  if (m.message.stickerMessage) return 'sticker';
  if (m.message.contactMessage) return 'contact';
  if (m.message.locationMessage) return 'location';
  return null;
}

export function extractSender(m, from, isGroup) {
  if (!isGroup) return from;
  const participant = m.key?.participant || m.key?.participantAlt || m.participant || null;
  if (participant && participant !== '' && !participant.endsWith('@g.us') && !participant.endsWith('@broadcast')) {
    return participant;
  }
  if (m.key?.fromMe) return 'jarvis@bot';
  return from;
}

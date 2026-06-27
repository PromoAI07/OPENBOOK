// api.js
// A small wrapper around fetch so every call sends cookies and parses JSON,
// plus named helpers for every endpoint. Shared by the landing page and the app.

const API = {
  async request(method, url, body, isForm) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined && body !== null) {
      if (isForm) {
        opts.body = body; // FormData, browser sets the content type
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const message = (data && data.error) || 'Request failed (' + res.status + ')';
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get(url) { return this.request('GET', url); },
  post(url, body) { return this.request('POST', url, body); },
  put(url, body) { return this.request('PUT', url, body); },
  del(url) { return this.request('DELETE', url); },
  postForm(url, formData) { return this.request('POST', url, formData, true); },

  // Auth
  signup(name, email, password, extra) { return this.post('/api/auth/signup', Object.assign({ name, email, password }, extra || {})); },
  signupChallenge() { return this.get('/api/auth/challenge'); },
  login(email, password) { return this.post('/api/auth/login', { email, password }); },
  logout() { return this.post('/api/auth/logout'); },
  me() { return this.get('/api/auth/me'); },
  resendVerification() { return this.post('/api/auth/resend-verification'); },
  forgotPassword(email) { return this.post('/api/auth/forgot-password', { email }); },
  resetPassword(token, password) { return this.post('/api/auth/reset-password', { token, password }); },
  support() { return this.get('/api/support'); },
  tiers() { return this.get('/api/tiers'); },
  // Admin (supporter tiers)
  adminGrantTier(userId, tier, days) { return this.post('/api/admin/grant', { userId, tier, days }); },
  adminRevokeTier(userId) { return this.post('/api/admin/revoke', { userId }); },
  adminSupporters() { return this.get('/api/admin/supporters'); },
  adminAnalytics() { return this.get('/api/admin/analytics'); },
  // Referrals
  myReferral() { return this.get('/api/referrals/me'); },
  referralLeaderboard() { return this.get('/api/referrals/leaderboard'); },
  // Suggestion board (named listSuggestions to avoid clashing with friends' suggestions())
  listSuggestions(status) { return this.get('/api/suggestions' + (status ? '?status=' + encodeURIComponent(status) : '')); },
  createSuggestion(title, body, category) { return this.post('/api/suggestions', { title, body, category }); },
  voteSuggestion(id, value) { return this.post('/api/suggestions/' + id + '/vote', { value }); },
  suggestionStatus(id, status) { return this.post('/api/suggestions/' + id + '/status', { status }); },
  deleteSuggestion(id) { return this.del('/api/suggestions/' + id); },

  // Users
  searchUsers(q) { return this.get('/api/users?q=' + encodeURIComponent(q || '')); },
  getProfile(id) { return this.get('/api/users/' + id); },
  updateProfile(name, bio) { return this.put('/api/users/me', { name, bio }); },
  myStats() { return this.get('/api/users/me/stats'); },
  myAnalytics() { return this.get('/api/users/me/analytics'); },
  deleteAccount(password) { return this.request('DELETE', '/api/users/me', { password }); },
  uploadAvatar(file) { const f = new FormData(); f.append('image', file); return this.postForm('/api/users/me/avatar', f); },
  uploadCover(file) { const f = new FormData(); f.append('image', file); return this.postForm('/api/users/me/cover', f); },
  userFriends(id) { return this.get('/api/users/' + id + '/friends'); },

  // Posts
  feed() { return this.get('/api/posts/feed'); },
  homeFeed(sort, t) {
    const params = [];
    if (sort) params.push('sort=' + encodeURIComponent(sort));
    if (t) params.push('t=' + encodeURIComponent(t));
    return this.get('/api/posts/feed/home' + (params.length ? '?' + params.join('&') : ''));
  },
  discoverFeed(sort, t) {
    const params = [];
    if (sort) params.push('sort=' + encodeURIComponent(sort));
    if (t) params.push('t=' + encodeURIComponent(t));
    return this.get('/api/posts/feed/discover' + (params.length ? '?' + params.join('&') : ''));
  },
  userPosts(id) { return this.get('/api/posts/user/' + id); },
  createPost(content, file, audience, opts) {
    opts = opts || {};
    const f = new FormData();
    f.append('content', content || '');
    if (audience) f.append('audience', audience);
    if (file) f.append('image', file);
    if (opts.bg) f.append('bg', opts.bg);
    if (opts.fileUrl) { f.append('fileUrl', opts.fileUrl); f.append('fileName', opts.fileName || 'file'); }
    if (opts.pollOptions && opts.pollOptions.length) f.append('pollOptions', JSON.stringify(opts.pollOptions));
    return this.postForm('/api/posts', f);
  },
  uploadPostFile(file) { const f = new FormData(); f.append('file', file); return this.postForm('/api/posts/upload-file', f); },
  pollVote(postId, optionId) { return this.post('/api/posts/' + postId + '/poll/vote', { optionId }); },
  deletePost(id) { return this.del('/api/posts/' + id); },
  editPost(id, fields) { return this.put('/api/posts/' + id, fields); },
  postHistory(id) { return this.get('/api/posts/' + id + '/history'); },
  react(targetType, targetId, type) { return this.post('/api/reactions', { targetType, targetId, type }); },
  comments(postId) { return this.get('/api/posts/' + postId + '/comments'); },
  addComment(postId, content, parentId) { return this.post('/api/posts/' + postId + '/comments', { content, parentId }); },
  deleteComment(id) { return this.del('/api/comments/' + id); },

  // Friends
  friends() { return this.get('/api/friends'); },
  friendRequests() { return this.get('/api/friends/requests'); },
  suggestions() { return this.get('/api/friends/suggestions'); },
  sendRequest(id) { return this.post('/api/friends/request/' + id); },
  acceptRequest(id) { return this.post('/api/friends/accept/' + id); },
  declineRequest(id) { return this.post('/api/friends/decline/' + id); },
  unfriend(id) { return this.del('/api/friends/' + id); },

  // Notifications
  notifications() { return this.get('/api/notifications'); },
  unreadNotifs() { return this.get('/api/notifications/unread-count'); },
  markNotifsRead() { return this.post('/api/notifications/read'); },

  // Stories
  stories() { return this.get('/api/stories'); },
  createStory(file, caption) {
    const f = new FormData();
    f.append('image', file);
    f.append('caption', caption || '');
    return this.postForm('/api/stories', f);
  },

  // Messages
  conversations() { return this.get('/api/messages/conversations'); },
  unreadMessages() { return this.get('/api/messages/unread-count'); },
  history(userId) { return this.get('/api/messages/' + userId); },

  // Marketplace
  listings(q, category) {
    const params = [];
    if (q) params.push('q=' + encodeURIComponent(q));
    if (category) params.push('category=' + encodeURIComponent(category));
    return this.get('/api/marketplace' + (params.length ? '?' + params.join('&') : ''));
  },
  myListings() { return this.get('/api/marketplace/mine'); },
  listing(id) { return this.get('/api/marketplace/' + id); },
  createListing(fields, file) {
    const f = new FormData();
    Object.keys(fields).forEach((k) => f.append(k, fields[k] == null ? '' : fields[k]));
    if (file) f.append('image', file);
    return this.postForm('/api/marketplace', f);
  },
  toggleSold(id) { return this.post('/api/marketplace/' + id + '/sold'); },
  deleteListing(id) { return this.del('/api/marketplace/' + id); },

  // Groups
  groups() { return this.get('/api/groups'); },
  group(id) { return this.get('/api/groups/' + id); },
  createGroup(fields, coverFile) {
    const f = new FormData();
    Object.keys(fields).forEach((k) => f.append(k, fields[k] == null ? '' : fields[k]));
    if (coverFile) f.append('cover', coverFile);
    return this.postForm('/api/groups', f);
  },
  joinGroup(id) { return this.post('/api/groups/' + id + '/join'); },
  leaveGroup(id) { return this.post('/api/groups/' + id + '/leave'); },
  groupMembers(id) { return this.get('/api/groups/' + id + '/members'); },
  groupPosts(id) { return this.get('/api/groups/' + id + '/posts'); },
  createGroupPost(id, content, file) {
    const f = new FormData();
    f.append('content', content || '');
    if (file) f.append('image', file);
    return this.postForm('/api/groups/' + id + '/posts', f);
  },
  deleteGroup(id) { return this.del('/api/groups/' + id); },

  // Albums
  userAlbums(userId) { return this.get('/api/albums/user/' + userId); },
  album(id) { return this.get('/api/albums/' + id); },
  createAlbum(title) { return this.post('/api/albums', { title }); },
  addAlbumPhoto(id, file, caption) {
    const f = new FormData();
    f.append('image', file);
    f.append('caption', caption || '');
    return this.postForm('/api/albums/' + id + '/photos', f);
  },
  deleteAlbum(id) { return this.del('/api/albums/' + id); },
  deleteAlbumPhoto(albumId, photoId) { return this.del('/api/albums/' + albumId + '/photos/' + photoId); },

  // Communities
  communities() { return this.get('/api/communities'); },
  community(id) { return this.get('/api/communities/' + id); },
  createCommunity(fields, iconFile) {
    const f = new FormData();
    Object.keys(fields).forEach((k) => f.append(k, fields[k] == null ? '' : fields[k]));
    if (iconFile) f.append('icon', iconFile);
    return this.postForm('/api/communities', f);
  },
  joinCommunity(id) { return this.post('/api/communities/' + id + '/join'); },
  leaveCommunity(id) { return this.post('/api/communities/' + id + '/leave'); },
  communityMembers(id) { return this.get('/api/communities/' + id + '/members'); },
  communityPosts(id, sort, t) {
    const params = [];
    if (sort) params.push('sort=' + encodeURIComponent(sort));
    if (t) params.push('t=' + encodeURIComponent(t));
    return this.get('/api/communities/' + id + '/posts' + (params.length ? '?' + params.join('&') : ''));
  },
  createCommunityPost(id, fields, file) {
    const f = new FormData();
    Object.keys(fields).forEach((k) => f.append(k, fields[k] == null ? '' : fields[k]));
    if (file) f.append('image', file);
    return this.postForm('/api/communities/' + id + '/posts', f);
  },
  deleteCommunity(id) { return this.del('/api/communities/' + id); },

  // Votes + single post (for the community post detail view)
  vote(targetType, targetId, value) { return this.post('/api/votes', { targetType, targetId, value }); },
  getPost(id) { return this.get('/api/posts/' + id); },

  // Moderation (Phase 3/4)
  report(targetType, targetId, reasonCode, detail) { return this.post('/api/moderation/reports', { targetType, targetId, reasonCode, detail }); },
  modReports() { return this.get('/api/moderation/reports'); },
  dismissReport(id) { return this.post('/api/moderation/reports/' + id + '/dismiss'); },
  modRemove(targetType, targetId, reason) { return this.post('/api/moderation/remove', { targetType, targetId, reason }); },
  modRestore(targetType, targetId) { return this.post('/api/moderation/restore', { targetType, targetId }); },
  modLock(postId, locked) { return this.post('/api/moderation/lock', { postId, locked }); },
  modPin(postId, pinned) { return this.post('/api/moderation/pin', { postId, pinned }); },
  communityBan(communityId, userId, reason) { return this.post('/api/moderation/community/' + communityId + '/ban', { userId, reason }); },
  communityUnban(communityId, userId) { return this.post('/api/moderation/community/' + communityId + '/unban', { userId }); },
  communityModLog(communityId) { return this.get('/api/moderation/community/' + communityId + '/log'); },
  fileAppeal(message, targetType, targetId) { return this.post('/api/moderation/appeals', { message, targetType, targetId }); },
  modAppeals() { return this.get('/api/moderation/appeals'); },
  resolveAppeal(id, decision) { return this.post('/api/moderation/appeals/' + id + '/resolve', { decision }); },

  // Reels
  reels() { return this.get('/api/reels'); },
  createReel(file, caption) {
    const f = new FormData();
    f.append('video', file);
    f.append('caption', caption || '');
    return this.postForm('/api/reels', f);
  },
  likeReel(id) { return this.post('/api/reels/' + id + '/like'); },
  viewReel(id) { return this.post('/api/reels/' + id + '/view'); },
  reelComments(id) { return this.get('/api/reels/' + id + '/comments'); },
  addReelComment(id, content) { return this.post('/api/reels/' + id + '/comments', { content }); },
  deleteReel(id) { return this.del('/api/reels/' + id); },
};

window.API = API;

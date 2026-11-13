// Answers the few www endpoints the limits gate calls: a listing for any slug except `missing`, which is a 404.
export default {
  fetch(request) {
    const { pathname } = new URL(request.url);
    const slug = pathname.split('/').at(-1);
    if (pathname.startsWith('/api/directory/listing/')) {
      return slug === 'missing' ? Response.json({ error: 'not_found' }, { status: 404 })
        : Response.json({ listing: { name: 'Gate listing', slug } });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
};

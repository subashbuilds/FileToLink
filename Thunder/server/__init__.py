# Thunder/server/__init__.py

from aiohttp import web
from .stream_routes import routes
from .track_routes import routes as track_routes


async def web_server():
    web_app = web.Application(client_max_size=50 * 1024 * 1024)
    # Track API first: stream_routes ends with a catch-all /{path:.+} route.
    web_app.add_routes(track_routes)
    web_app.add_routes(routes)
    return web_app

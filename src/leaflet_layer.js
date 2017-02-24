import Thread from './utils/thread';
import Scene from './scene';
import Geo from './geo';

// Exports must appear outside a function, but will only be defined in main thread (below)
export var LeafletLayer;
export function leafletLayer(options) {
    return extendLeaflet(options);
}

function extendLeaflet(options) {

    // If LeafletLayer is already defined when this is called just return that immediately
    // e.g. if you call leafletLayer multiple times (which is valid)
    if (typeof LeafletLayer !== 'undefined') {
        return new LeafletLayer(options);
    }

    // Leaflet layer functionality is only defined in main thread
    if (Thread.is_main) {

        let L = options.leaflet || window.L;

        // Determine if we are extending the leaflet 0.7.x TileLayer class, or the newer
        // leaflet 1.x GridLayer class.
        let layerBaseClass = L.GridLayer ? L.GridLayer : L.TileLayer;
        let leafletVersion = layerBaseClass === L.GridLayer ? '1.x' : '0.7.x';
        let layerClassConfig = {};

        // If extending leaflet 0.7.x TileLayer, additional modifications are needed
        if (layerBaseClass === L.TileLayer) {
            layerClassConfig._addTile = function(){};
            layerClassConfig._removeTile = function(){};
            layerClassConfig._reset = function() {
                layerBaseClass.prototype._reset.apply(this, arguments);
                // re-add the canvas since base class `viewreset` event can remove it
                if (this.scene && this.scene.container && this.scene.canvas) {
                    this.scene.container.appendChild(this.scene.canvas);
                }
            };
        }

        // Define custom layer methods
        Object.assign(layerClassConfig, {

            initialize: function (options) {
                // Defaults
                options.showDebug = (!options.showDebug ? false : true);

                L.setOptions(this, options);
                this.createScene();
                this.hooks = {};
                this._updating_tangram = false;

                // Force leaflet zoom animations off
                this._zoomAnimated = false;
            },

            createScene: function () {
                this.scene = Scene.create(
                    this.options.scene,
                    {
                        numWorkers: this.options.numWorkers,
                        preUpdate: this.options.preUpdate,
                        postUpdate: this.options.postUpdate,
                        continuousZoom: (LeafletLayer.leafletVersion === '1.x'),
                        highDensityDisplay: this.options.highDensityDisplay,
                        logLevel: this.options.logLevel,
                        introspection: this.options.introspection,
                        // advanced option, app will have to manually called scene.update() per frame
                        disableRenderLoop: this.options.disableRenderLoop,
                        // advanced option, will require library to be served as same host as page
                        allowCrossDomainWorkers: this.options.allowCrossDomainWorkers
                    });
            },

            // Finish initializing scene and setup events when layer is added to map
            onAdd: function (map) {
                if (!this.scene) {
                    this.createScene();
                }

                layerBaseClass.prototype.onAdd.apply(this, arguments);

                this.hooks.resize = () => {
                    this._updating_tangram = true;
                    this.updateSize();
                    this._updating_tangram = false;
                };
                map.on('resize', this.hooks.resize);

                this.hooks.move = () => {
                    if (this._updating_tangram) {
                        return;
                    }

                    this._updating_tangram = true;
                    var view = map.getCenter();
                    view.zoom = Math.min(map.getZoom(), map.getMaxZoom() || Geo.default_view_max_zoom);

                    this.scene.view.setView(view);
                    this.scene.immediateRedraw();
                    this.reverseTransform();
                    this._updating_tangram = false;
                };
                map.on('move', this.hooks.move);

                this.hooks.zoomstart = () => {
                    if (this._updating_tangram) {
                        return;
                    }

                    this._updating_tangram = true;
                    this.scene.view.startZoom();
                    this._updating_tangram = false;
                };
                map.on('zoomstart', this.hooks.zoomstart);

                this.hooks.dragstart = () => {
                    this.scene.view.panning = true;
                };
                map.on('dragstart', this.hooks.dragstart);

                this.hooks.dragend = () => {
                    this.scene.view.panning = false;
                };
                map.on('dragend', this.hooks.dragend);

                // Force leaflet zoom animations off
                map._zoomAnimated = false;

                // Modify default Leaflet behaviors
                this.modifyScrollWheelBehavior(map);
                this.modifyDoubleClickZoom(map);

                // Setup feature selection
                this.setupSelectionEventHandlers(map);
                this.setSelectionEvents(this.options.events);

                // Add GL canvas to layer container
                this.scene.container = this.getContainer();
                this.updateSize();

                // Initial view
                this.updateView();

                // Subscribe to tangram events
                this.scene.subscribe({
                    move: this.onTangramViewUpdate.bind(this)
                });

                // Use leaflet's existing event system as the callback mechanism
                this.scene.load(this.options.scene, this.options.sceneBasePath).then(() => {
                    this._updating_tangram = true;

                    this.updateSize();
                    this.updateView();
                    this.reverseTransform();

                    this._updating_tangram = false;

                    this.fire('init');
                }).catch(error => {
                    this.fire('error', error);
                });
            },

            onRemove: function (map) {
                layerBaseClass.prototype.onRemove.apply(this, arguments);

                map.off('resize', this.hooks.resize);
                map.off('move', this.hooks.move);
                map.off('zoomstart', this.hooks.zoomstart);
                map.off('dragstart', this.hooks.dragstart);
                map.off('dragend', this.hooks.dragend);
                map.off('click', this.hooks.click);
                map.off('mousemove', this.hooks.mousemove);
                map.off('mouseout', this.hooks.mouseout);
                this.hooks = {};

                if (this.scene) {
                    this.scene.destroy();
                    this.scene = null;
                }
            },

            createTile: function (coords) {
                var key = coords.x + '/' + coords.y + '/' + coords.z;
                var div = document.createElement('div');
                div.setAttribute('data-tile-key', key);
                div.style.width = '256px';
                div.style.height = '256px';

                if (this.options.showDebug) {
                    var debug_overlay = document.createElement('div');
                    debug_overlay.textContent = key;
                    debug_overlay.style.position = 'absolute';
                    debug_overlay.style.left = 0;
                    debug_overlay.style.top = 0;
                    debug_overlay.style.color = 'white';
                    debug_overlay.style.fontSize = '16px';
                    debug_overlay.style.textOutline = '1px #000000';
                    debug_overlay.style.padding = '8px';

                    div.appendChild(debug_overlay);
                    div.style.borderStyle = 'solid';
                    div.style.borderColor = 'white';
                    div.style.borderWidth = '1px';
                }

                return div;
            },

            // Modify leaflet's default scroll wheel behavior to render frames more frequently
            // (should generally lead to smoother scroll with Tangram frame re-render)
            modifyScrollWheelBehavior: function (map) {
                if (this.scene.view.continuous_zoom && map.scrollWheelZoom && this.options.modifyScrollWheel !== false) {
                    map.options.zoomSnap = 0;
                    map.scrollWheelZoom.disable();

                    map.scrollWheelZoom._onWheelScroll = function (e) {
                        var delta = L.DomEvent.getWheelDelta(e);
                        this._delta += delta;
                        this._lastMousePos = this._map.mouseEventToContainerPoint(e);
                        this._performZoom();
                        L.DomEvent.stop(e);
                    };

                    map.scrollWheelZoom._performZoom = function () {
                        var map = this._map,
                            zoom = map.getZoom();

                        map._stop(); // stop panning and fly animations if any

                        var delta = this._delta / (this._map.options.wheelPxPerZoomLevel * 4);
                        this._delta = 0;

                        if ((zoom + delta) >= this._map.getMaxZoom()) {
                            delta = this._map.getMaxZoom() - zoom; // don't go past max zoom
                        }

                        if (!delta) { return; }

                        if (map.options.scrollWheelZoom === 'center') {
                            map.setZoom(zoom + delta);
                        } else {
                            map.setZoomAround(this._lastMousePos, zoom + delta);
                        }
                    };

                    map.scrollWheelZoom.enable();
                }
            },

            // Modify leaflet's default double-click zoom behavior, to match typical vector basemap products
            modifyDoubleClickZoom: function (map) {
                if (this.scene.view.continuous_zoom && map.doubleClickZoom && this.options.modifyDoubleClickZoom !== false) {

                    // Modified version of Leaflet's setZoomAround that doesn't trigger a moveEnd event
                    const setZoomAroundNoMoveEnd = function (map, latlng, zoom, options) {
                        var scale = map.getZoomScale(zoom),
                            viewHalf = map.getSize().divideBy(2),
                            containerPoint = latlng instanceof L.Point ? latlng : map.latLngToContainerPoint(latlng),

                            centerOffset = containerPoint.subtract(viewHalf).multiplyBy(1 - 1 / scale),
                            newCenter = map.containerPointToLatLng(viewHalf.add(centerOffset));

                        return map._move(newCenter, zoom, { flyTo: true });
                    };

                    // Simplified version of Leaflet's flyTo, for short animations zooming around a point
                    const flyAround = function (map, targetCenter, targetZoom, options) {
                        options = options || {};
                        if (options.animate === false || !L.Browser.any3d) {
                            return map.setView(targetCenter, targetZoom, options);
                        }

                        map._stop();

                        var startZoom = map._zoom;

                        targetCenter = L.latLng(targetCenter);
                        targetZoom = targetZoom === undefined ? startZoom : targetZoom;

                        var from = map.project(map.getCenter(), startZoom),
                            to = map.project(targetCenter, startZoom);

                        var start = Date.now(),
                            duration = options.duration ? 1000 * options.duration : 75;

                        function frame() {
                            var t = (Date.now() - start) / duration;

                            if (t <= 1) {
                                // reuse internal flyTo frame to ensure these animations are canceled like others
                                map._flyToFrame = L.Util.requestAnimFrame(frame, map);

                                var center = from.add(to.subtract(from).multiplyBy(t));
                                center = [center.x, center.y];
                                center = Geo.metersToLatLng(center);
                                setZoomAroundNoMoveEnd(map, targetCenter, startZoom + (targetZoom - startZoom) * t);
                            } else {
                                setZoomAroundNoMoveEnd(map, targetCenter, targetZoom)
                                    ._moveEnd(true);
                            }
                        }

                        map._moveStart(true);

                        frame.call(map);
                        return map;
                    };

                    // Modify the double-click zoom handler to do a short zoom animation
                    map.doubleClickZoom.disable();

                    map.doubleClickZoom._onDoubleClick = function (e) {
                        var map = this._map,
                            oldZoom = map.getZoom(),
                            delta = map.options.zoomDelta,
                            zoom = e.originalEvent.shiftKey ? oldZoom - delta : oldZoom + delta;

                        if (map.options.doubleClickZoom === 'center') {
                            flyAround(map, map.getCenter(), zoom);
                        } else {
                            flyAround(map, map.containerPointToLatLng(e.containerPoint), zoom);
                        }
                    };

                    map.doubleClickZoom.enable();
                }
            },

            updateView: function () {
                var view = this._map.getCenter();
                view.zoom = Math.min(this._map.getZoom(), this._map.getMaxZoom() || Geo.default_view_max_zoom);
                this.scene.view.setView(view);
            },

            updateSize: function () {
                var size = this._map.getSize();
                this.scene.resizeMap(size.x, size.y);
            },

            onTangramViewUpdate: function () {
                if (!this._map || this._updating_tangram) {
                    return;
                }
                this._updating_tangram = true;
                this._map.setView([this.scene.view.center.lat, this.scene.view.center.lng], this.scene.view.zoom, { animate: false });
                this.reverseTransform();
                this._updating_tangram = false;
            },

            render: function () {
                if (!this.scene) {
                    return;
                }
                this.scene.update();
            },

            // Reverse the CSS positioning Leaflet applies to the layer, since Tangram's WebGL canvas
            // is expected to be 'absolutely' positioned.
            reverseTransform: function () {
                if (!this._map || !this.scene || !this.scene.container) {
                    return;
                }

                var top_left = this._map.containerPointToLayerPoint([0, 0]);
                L.DomUtil.setPosition(this.scene.container, top_left);
            },

            // Tie Leaflet event handlers to Tangram feature selection
            setupSelectionEventHandlers: function (map) {
                this._selection_events = {};

                this.hooks.click = (event) => {
                    if (typeof this._selection_events.click === 'function') {
                        this.scene.getFeatureAt(event.containerPoint).
                            then(selection => {
                                let results = Object.assign({}, selection, { leaflet_event: event });
                                this._selection_events.click(results);
                            });
                    }
                };
                map.on('click', this.hooks.click);

                this.hooks.mousemove = (event) => {
                    if (typeof this._selection_events.hover === 'function') {
                        this.scene.getFeatureAt(event.containerPoint).
                            then(selection => {
                                let results = Object.assign({}, selection, { leaflet_event: event });
                                this._selection_events.hover(results);
                            });
                    }
                };
                map.on('mousemove', this.hooks.mousemove);

                this.hooks.mouseout = (event) => {
                    // When mouse leaves map, send an additional selection event to indicate no feature is selected
                    if (typeof this._selection_events.hover === 'function') {
                        this._selection_events.hover({ changed: true, leaflet_event: event });
                    }
                };
                map.on('mouseout', this.hooks.mouseout);
            },

            // Set user-defined handlers for feature selection events
            // Currently only one handler can be defined for each event type
            // Event types are: `click`, `hover` (leaflet `mousemove`)
            setSelectionEvents: function (events) {
                this._selection_events = Object.assign(this._selection_events, events);
            }

        });

        // Create the layer class
        LeafletLayer = layerBaseClass.extend(layerClassConfig);

        // Polyfill some 1.0 methods
        if (typeof LeafletLayer.remove !== 'function') {
            LeafletLayer.prototype.remove = function() {
                if (this._map) {
                    this._map.removeLayer(this);
                }
                this.fire('remove');
            };
        }

        LeafletLayer.layerBaseClass = layerBaseClass;
        LeafletLayer.leafletVersion = leafletVersion;

        return new LeafletLayer(options);
    }
}

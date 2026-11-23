"""Regression checks for restoring the monitor where the HUD was closed."""
import unittest
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch

from backend.main import Api, _startup_window
from backend.monitors import _logical_bounds


LEFT = dict(device=r'\\.\DISPLAY2', x=-1920, y=0, width=1920, height=1080, primary=False)
PRIMARY = dict(device=r'\\.\DISPLAY1', x=0, y=0, width=3440, height=1440, primary=True)


class WindowPositionTests(unittest.TestCase):
    def setUp(self):
        self.config = {'monitor': 'auto', 'window': dict(x=-1972, y=399, width=1920, height=1080)}

    def window(self, x, y):
        shown = Event()
        shown.set()
        return SimpleNamespace(x=x, y=y, events=SimpleNamespace(shown=shown))

    def test_legacy_position_on_left_display(self):
        geometry, device = _startup_window(self.config, [LEFT, PRIMARY], fill_screen=False)
        self.assertEqual(device, LEFT['device'])
        self.assertEqual(geometry, self.config['window'])

    def test_fullscreen_uses_saved_device_even_if_coordinates_are_on_primary(self):
        self.config['window'].update(last_monitor=LEFT['device'], x=1787, y=1395)
        geometry, device = _startup_window(self.config, [LEFT, PRIMARY], fill_screen=True)
        self.assertEqual(device, LEFT['device'])
        self.assertEqual((geometry['x'], geometry['y']), (-1920, 0))

    def test_explicit_monitor_takes_precedence(self):
        self.config['monitor'] = PRIMARY['device']
        geometry, device = _startup_window(self.config, [LEFT, PRIMARY], fill_screen=True)
        self.assertEqual(device, PRIMARY['device'])
        self.assertGreaterEqual(geometry['x'], 0)

    def test_closed_without_move_event_saves_actual_display(self):
        api = Api(None, self.config)
        api.set_window(self.window(-1920, 0))
        with patch('backend.main.window_device', return_value=LEFT['device']), \
                patch('backend.main.save_config_keys') as save:
            api.window_closing()
        save.assert_called_once_with({'window': {'last_monitor': LEFT['device'], 'x': -1920, 'y': 0}})

    def test_disconnected_monitor_is_preserved_through_primary_fallback(self):
        self.config['window']['last_monitor'] = LEFT['device']
        geometry, device = _startup_window(self.config, [PRIMARY], fill_screen=True)
        self.assertEqual(device, LEFT['device'])
        self.assertGreaterEqual(geometry['x'], 0)
        api = Api(None, self.config)
        api._last_monitor = device
        with patch('backend.main.window_device', return_value=PRIMARY['device']), \
                patch('backend.main.list_monitors', return_value=[PRIMARY]), \
                patch('backend.main.save_config_keys') as save:
            api.window_closing()
        save.assert_not_called()

    def test_minimized_coordinates_do_not_replace_saved_position(self):
        api = Api(None, self.config)
        api.set_window(self.window(-32000, -32000))
        with patch('backend.main.window_device', return_value=LEFT['device']), \
                patch('backend.main.save_config_keys') as save:
            api.window_closing()
        save.assert_called_once_with({'window': {'last_monitor': LEFT['device']}})

    def test_close_before_window_is_shown_can_still_save_the_monitor(self):
        api = Api(None, self.config)
        api.set_window(SimpleNamespace(events=SimpleNamespace(shown=Event())))
        with patch('backend.main.window_device', return_value=LEFT['device']), \
                patch('backend.main.save_config_keys') as save:
            api.window_closing()
        save.assert_called_once_with({'window': {'last_monitor': LEFT['device']}})

    def test_scaled_launch_rect_is_inside_small_screen_above_or_to_the_right(self):
        for dpi in (96, 120, 144, 192):
            for x, y in ((-1280, -720), (3440, 400), (600, -720)):
                with self.subTest(dpi=dpi, x=x, y=y):
                    side = dict(LEFT, x=x, y=y, width=1280, height=720)
                    screens = [_logical_bounds(m, dpi) for m in (PRIMARY, side)]
                    self.config['window']['last_monitor'] = side['device']
                    geom, device = _startup_window(self.config, screens, fill_screen=True)
                    self.assertEqual(device, side['device'])
                    for axis, size in (('x', 'width'), ('y', 'height')):
                        origin = int(geom[axis] * dpi / 96)
                        end = origin + int(geom[size] * dpi / 96)
                        self.assertGreaterEqual(origin, side[axis] - 1)
                        self.assertLessEqual(end, side[axis] + side[size] + 1)

    def test_offscreen_title_after_resolution_change_is_brought_back(self):
        self.config['window'].update(x=-1500, y=-800)
        geom, device = _startup_window(self.config, [LEFT, PRIMARY], fill_screen=False)
        self.assertEqual(device, LEFT['device'])
        self.assertGreaterEqual(geom['y'], LEFT['y'])

    def test_bad_saved_geometry_and_unavailable_screen_list(self):
        self.config['window'].update(width='bad', height=-5, x=[], y='400', last_monitor=[])
        for screens in ([], [PRIMARY]):
            geometry, remembered = _startup_window(self.config, screens, fill_screen=True)
            self.assertEqual((geometry['width'], geometry['height']), (1920, 1080))
            self.assertIsNone(remembered)
            if not screens:
                self.assertIsNone(geometry['x'])

    def test_reconnected_screen_in_new_location(self):
        self.config['window']['last_monitor'] = LEFT['device']
        relocated = dict(LEFT, x=3440, y=-200)
        geom, device = _startup_window(self.config, [PRIMARY, relocated], fill_screen=False)
        self.assertEqual(device, LEFT['device'])
        self.assertEqual(geom['x'], relocated['x'])

    def test_unplug_after_moving_to_a_new_screen_before_first_close(self):
        self.config['window']['last_monitor'] = PRIMARY['device']
        api = Api(None, self.config)
        api._last_monitor = PRIMARY['device']
        with patch('backend.main.window_device', return_value=LEFT['device']), \
                patch('backend.main.list_monitors', return_value=[PRIMARY, LEFT]):
            api.window_moved(-1800, 80)
        with patch('backend.main.window_device', return_value=PRIMARY['device']), \
                patch('backend.main.list_monitors', return_value=[PRIMARY]), \
                patch('backend.main.save_config_keys') as save:
            api.window_moved(0, 0)
            api.window_closing()
        save.assert_called_once_with({'window': {'last_monitor': LEFT['device']}})

    def test_minimized_at_150_percent_dpi_keeps_previous_coordinates(self):
        api = Api(None, self.config)
        window = self.window(-21333, -21333)
        window.native = SimpleNamespace(WindowState='Minimized')
        api.set_window(window)
        with patch('backend.main.window_device', return_value=LEFT['device']), \
                patch('backend.main.save_config_keys') as save:
            api.window_closing()
        save.assert_called_once_with({'window': {'last_monitor': LEFT['device']}})

from pathlib import Path
from playwright.sync_api import sync_playwright

ARTIFACTS = Path('/tmp/shoebox-ui-e2e')
ARTIFACTS.mkdir(parents=True, exist_ok=True)

print('STEP playwright', flush=True)
with sync_playwright() as p:
    print('STEP launch', flush=True)
    browser = p.chromium.launch(headless=True)
    print('STEP launched', flush=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
    page.set_default_timeout(5000)
    errors = []
    page.on("console", lambda message: errors.append(f"console:{message.type}:{message.text}") if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(f"pageerror:{error}"))
    print('STEP goto desktop', flush=True)
    page.goto('http://127.0.0.1:4173', wait_until='domcontentloaded', timeout=10000)
    print('STEP desktop loaded', flush=True)

    assert page.get_by_role('heading', name='Tell it what grandma wants from the family’s holiday folder.').is_visible()
    print('STEP click sample', flush=True)
    page.get_by_role('button', name='Open sample album').click(timeout=10000)
    print('STEP sample clicked', flush=True)
    print('STEP waiting indexed', flush=True)
    page.get_by_text('500 photos indexed').wait_for(timeout=5000)
    print('STEP indexed visible', flush=True)
    assert page.get_by_role('region', name='Duplicates tray').is_visible()
    assert page.get_by_role('region', name='Bà Nội’s Tết album').is_visible()
    assert page.get_by_text('Commit 312 moves plus 1 album, 0 deletes').is_visible()
    assert page.get_by_role('gridcell').count() < 150

    first = page.get_by_role('button', name='Select Pagoda, photo 1', exact=True)
    first.click()
    selected = page.get_by_role('button', name='Unselect Pagoda, photo 1', exact=True)
    assert selected.get_attribute('aria-pressed') == 'true'
    print('STEP desktop screenshot', flush=True)
    page.screenshot(path=str(ARTIFACTS / 'desktop-staged.png'), timeout=10000)
    print('STEP desktop shot', flush=True)

    mobile = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=1)
    print('STEP mobile goto', flush=True)
    mobile.set_default_timeout(5000)
    mobile.goto('http://127.0.0.1:4173', wait_until='domcontentloaded', timeout=10000)
    print('STEP mobile loaded', flush=True)
    mobile.get_by_role('button', name='Open sample album').click()
    mobile.get_by_text('500 photos indexed').wait_for()
    assert mobile.get_by_role('button', name='Commit 312 moves plus 1 album, 0 deletes').is_visible()
    print('STEP mobile screenshot', flush=True)
    mobile.screenshot(path=str(ARTIFACTS / 'mobile-staged.png'), timeout=10000)
    print('STEP mobile shot', flush=True)

    assert errors == [], errors
    browser.close()

print('SHOEBOX_UI_E2E_PASS desktop+mobile zero-console-error')

<?php
/**
 * Plugin Name: Engine SEO
 * Description: Applies approved Engine (C2) schema/meta fixes to this site — the WordPress side of the 'cms-plugin' DeployTarget.
 * Version: 0.1.0
 * Author: Engine
 * License: proprietary
 *
 * How this fits the product (Architecture §1 Layer 4, roadmap C2.2 "CMS
 * plugin *or* Cloudflare Worker — no dev ticket"): the edge-worker deploy
 * target (apps/workers) reads live 'deployed' Actions and rewrites HTML on
 * every request for sites proxied through Cloudflare. A site that isn't
 * proxied that way — most WordPress installs — needs a different mechanism:
 * this plugin, running inside WordPress, does the same job natively.
 *
 * The push model is deliberately the inverse of the edge-worker's read model:
 * the edge-worker re-derives its transform on every request from whatever is
 * currently 'deployed'/'verified', so rollback is just a status flip it picks
 * up on the next request. This plugin instead *pulls* `approved` actions once
 * on a schedule (WP-Cron), writes them into WordPress's own storage (post
 * meta), and then calls the ordinary deploy transition to record the push —
 * after that, the action is 'deployed' and this plugin does not touch it
 * again. A rollback initiated in Engine (status -> 'rolled_back') is NOT
 * automatically reverted here: WordPress has no equivalent of "serve the
 * untransformed origin response," so a rolled-back schema/meta write stays in
 * post meta until the next real audit finds the same issue again and a new
 * fix is approved. This asymmetry is a known limitation of the push model,
 * not an oversight — the edge-worker path is the one to recommend to
 * customers who need instant rollback.
 */

if (!defined('ABSPATH')) {
	exit; // No direct access.
}

define('ENGINE_SEO_VERSION', '0.1.0');
define('ENGINE_SEO_CRON_HOOK', 'engine_seo_sync_actions');
define('ENGINE_SEO_META_SCHEMA', '_engine_seo_schema_jsonld');
define('ENGINE_SEO_META_TITLE', '_engine_seo_meta_title');
define('ENGINE_SEO_META_DESCRIPTION', '_engine_seo_meta_description');

// ── Activation / deactivation ────────────────────────────────────────────

register_activation_hook(__FILE__, function () {
	if (!wp_next_scheduled(ENGINE_SEO_CRON_HOOK)) {
		wp_schedule_event(time(), 'hourly', ENGINE_SEO_CRON_HOOK);
	}
});

register_deactivation_hook(__FILE__, function () {
	wp_clear_scheduled_hook(ENGINE_SEO_CRON_HOOK);
});

// ── Settings (API base URL, project id, site id, token) ─────────────────

add_action('admin_init', function () {
	register_setting('engine_seo', 'engine_seo_api_base', ['sanitize_callback' => 'esc_url_raw']);
	register_setting('engine_seo', 'engine_seo_project_id', ['sanitize_callback' => 'sanitize_text_field']);
	register_setting('engine_seo', 'engine_seo_site_id', ['sanitize_callback' => 'sanitize_text_field']);
	// The token is a bearer credential, same class as the crawl runner's
	// ENGINE_API_TOKEN (packages/crawler) — stored, never echoed back in the
	// settings form beyond a masked placeholder.
	register_setting('engine_seo', 'engine_seo_api_token', ['sanitize_callback' => 'sanitize_text_field']);
});

add_action('admin_menu', function () {
	add_options_page('Engine SEO', 'Engine SEO', 'manage_options', 'engine-seo', 'engine_seo_render_settings_page');
});

function engine_seo_render_settings_page() {
	if (!current_user_can('manage_options')) {
		return;
	}
	$last_sync = get_option('engine_seo_last_sync', '');
	$last_error = get_option('engine_seo_last_error', '');
	?>
	<div class="wrap">
		<h1>Engine SEO</h1>
		<p>Applies schema/meta fixes approved in Engine's Fix Queue to this site.</p>
		<form method="post" action="options.php">
			<?php settings_fields('engine_seo'); ?>
			<table class="form-table">
				<tr>
					<th><label for="engine_seo_api_base">Engine API base URL</label></th>
					<td><input type="url" id="engine_seo_api_base" name="engine_seo_api_base"
						value="<?php echo esc_attr(get_option('engine_seo_api_base', '')); ?>"
						class="regular-text" placeholder="https://api.engine.example.com" /></td>
				</tr>
				<tr>
					<th><label for="engine_seo_project_id">Project ID</label></th>
					<td><input type="text" id="engine_seo_project_id" name="engine_seo_project_id"
						value="<?php echo esc_attr(get_option('engine_seo_project_id', '')); ?>" class="regular-text" /></td>
				</tr>
				<tr>
					<th><label for="engine_seo_site_id">Site ID</label></th>
					<td><input type="text" id="engine_seo_site_id" name="engine_seo_site_id"
						value="<?php echo esc_attr(get_option('engine_seo_site_id', '')); ?>" class="regular-text" />
						<p class="description">The `siteId` this plugin installation was registered under (matches an Action's `target.siteId`).</p></td>
				</tr>
				<tr>
					<th><label for="engine_seo_api_token">API token</label></th>
					<td><input type="password" id="engine_seo_api_token" name="engine_seo_api_token"
						value="<?php echo esc_attr(get_option('engine_seo_api_token', '')); ?>" class="regular-text" /></td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>
		<h2>Sync status</h2>
		<p>Last sync: <?php echo esc_html($last_sync ?: 'never'); ?></p>
		<?php if ($last_error): ?>
			<p style="color:#b32d2e;">Last error: <?php echo esc_html($last_error); ?></p>
		<?php endif; ?>
		<form method="post">
			<?php wp_nonce_field('engine_seo_sync_now'); ?>
			<input type="hidden" name="engine_seo_sync_now" value="1" />
			<?php submit_button('Sync now', 'secondary'); ?>
		</form>
	</div>
	<?php
}

add_action('admin_init', function () {
	if (!isset($_POST['engine_seo_sync_now'])) {
		return;
	}
	if (!current_user_can('manage_options') || !check_admin_referer('engine_seo_sync_now')) {
		return;
	}
	engine_seo_sync_actions();
});

// ── Sync: pull approved actions, apply them, report deploy ──────────────

add_action(ENGINE_SEO_CRON_HOOK, 'engine_seo_sync_actions');

/**
 * Pull `approved` cms-plugin actions for this site, apply each to the
 * matching post's meta, and report it deployed. Best-effort per action: one
 * bad action (e.g. a page URL WordPress can't resolve) is skipped and logged
 * rather than aborting the whole sync — the rest still land.
 */
function engine_seo_sync_actions() {
	$api_base = trim(get_option('engine_seo_api_base', ''));
	$project_id = trim(get_option('engine_seo_project_id', ''));
	$site_id = trim(get_option('engine_seo_site_id', ''));
	$token = get_option('engine_seo_api_token', '');

	if (!$api_base || !$project_id || !$site_id || !$token) {
		update_option('engine_seo_last_error', 'not configured: set API base URL, project ID, site ID, and token first');
		return;
	}

	$url = trailingslashit($api_base) . 'projects/' . rawurlencode($project_id) . '/cms-plugin/actions'
		. '?plugin=wordpress&siteId=' . rawurlencode($site_id);

	$response = wp_remote_get($url, [
		'headers' => ['Authorization' => 'Bearer ' . $token],
		'timeout' => 15,
	]);

	if (is_wp_error($response)) {
		update_option('engine_seo_last_error', $response->get_error_message());
		return;
	}

	$status = wp_remote_retrieve_response_code($response);
	if ($status !== 200) {
		update_option('engine_seo_last_error', "actions fetch returned HTTP {$status}");
		return;
	}

	$body = json_decode(wp_remote_retrieve_body($response), true);
	$actions = is_array($body) && isset($body['actions']) && is_array($body['actions']) ? $body['actions'] : [];

	$applied = 0;
	foreach ($actions as $action) {
		if (engine_seo_apply_action($action)) {
			engine_seo_report_deployed($api_base, $project_id, $site_id, $token, $action['id']);
			$applied++;
		}
	}

	update_option('engine_seo_last_sync', current_time('mysql') . " ({$applied} applied)");
	update_option('engine_seo_last_error', '');
}

/**
 * Apply one Action's diff to the WordPress post matching its page URL.
 * Returns true on success (safe to report deployed), false to skip and retry
 * next sync (e.g. the post can't be resolved yet).
 */
function engine_seo_apply_action($action) {
	if (!is_array($action) || empty($action['pageUrl']) || empty($action['diff']) || empty($action['type'])) {
		return false;
	}

	$post_id = url_to_postid($action['pageUrl']);
	if (!$post_id) {
		error_log("Engine SEO: could not resolve a post for {$action['pageUrl']}, skipping action {$action['id']}");
		return false;
	}

	$diff = $action['diff'];
	if ($action['type'] === 'schema' && !empty($diff['after'])) {
		update_post_meta($post_id, ENGINE_SEO_META_SCHEMA, wp_slash($diff['after']));
		return true;
	}
	if ($action['type'] === 'meta' && !empty($diff['after']) && !empty($diff['field'])) {
		if ($diff['field'] === 'title') {
			update_post_meta($post_id, ENGINE_SEO_META_TITLE, sanitize_text_field($diff['after']));
			return true;
		}
		if ($diff['field'] === 'description') {
			update_post_meta($post_id, ENGINE_SEO_META_DESCRIPTION, sanitize_text_field($diff['after']));
			return true;
		}
	}

	// Other action types (redirect/robots/content/gbp) aren't this plugin's
	// job — the DeployTarget only routes here for types this plugin declared
	// it can handle, but a future ActionType a plugin doesn't recognize
	// should be left for a human, not silently marked deployed.
	return false;
}

function engine_seo_report_deployed($api_base, $project_id, $site_id, $token, $action_id) {
	$url = trailingslashit($api_base) . 'projects/' . rawurlencode($project_id)
		. '/actions/' . rawurlencode($action_id) . '/deploy';

	$response = wp_remote_post($url, [
		'headers' => [
			'Authorization' => 'Bearer ' . $token,
			'Content-Type' => 'application/json',
		],
		'body' => wp_json_encode(['actor' => 'wordpress-plugin:' . $site_id]),
		'timeout' => 15,
	]);

	if (is_wp_error($response)) {
		error_log('Engine SEO: failed to report deploy for action ' . $action_id . ': ' . $response->get_error_message());
	}
}

// ── Render: inject the applied schema/meta on the front end ─────────────

add_action('wp_head', function () {
	if (!is_singular()) {
		return;
	}
	$post_id = get_the_ID();
	if (!$post_id) {
		return;
	}

	$schema = get_post_meta($post_id, ENGINE_SEO_META_SCHEMA, true);
	if ($schema) {
		echo "\n<script type=\"application/ld+json\">\n" . $schema . "\n</script>\n";
	}

	$description = get_post_meta($post_id, ENGINE_SEO_META_DESCRIPTION, true);
	if ($description) {
		echo '<meta name="description" content="' . esc_attr($description) . "\">\n";
	}
}, 20);

// Title fixes go through WordPress's own title filter rather than wp_head,
// so they compose correctly with the theme's <title> tag structure (SEO
// plugins, site name suffixes, etc.) instead of emitting a second <title>.
add_filter('pre_get_document_title', function ($title) {
	if (!is_singular()) {
		return $title;
	}
	$post_id = get_the_ID();
	$override = $post_id ? get_post_meta($post_id, ENGINE_SEO_META_TITLE, true) : '';
	return $override ?: $title;
}, 20);

-- Esquema de card_db (card-service). Generado con pg_dump --schema-only desde la base
-- que crea TypeORM a partir de las entidades (src/**/entities, synchronize: true).
-- Restaurar en una base vacía:  psql "$DATABASE_URL" -f database/schema.sql

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: card_authorizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_authorizations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    card_id uuid NOT NULL,
    user_id uuid NOT NULL,
    amount numeric(18,2) NOT NULL,
    currency character varying(3) NOT NULL,
    channel character varying(10) NOT NULL,
    source character varying(15) NOT NULL,
    merchant_code character varying(40) NOT NULL,
    merchant_name character varying(80) NOT NULL,
    status character varying(10) NOT NULL,
    reason character varying(200),
    idempotency_key uuid NOT NULL,
    ledger_transaction_id uuid,
    bogota_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: card_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_outbox (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    routing_key character varying NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    published_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: card_settings_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_settings_audit (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    card_id uuid NOT NULL,
    user_id uuid NOT NULL,
    field character varying(30) NOT NULL,
    old_value character varying(40) NOT NULL,
    new_value character varying(40) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cards (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    account_id uuid NOT NULL,
    account_number character varying(11) NOT NULL,
    user_id uuid NOT NULL,
    pan_encrypted text NOT NULL,
    last_four character varying(4) NOT NULL,
    currency character varying(3) NOT NULL,
    expiry_month smallint NOT NULL,
    expiry_year smallint NOT NULL,
    status character varying DEFAULT 'active'::character varying NOT NULL,
    type character varying DEFAULT 'virtual'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    online_enabled boolean DEFAULT true NOT NULL,
    daily_limit numeric(18,2) DEFAULT '5000000'::numeric NOT NULL,
    cancelled_at timestamp with time zone
);


--
-- Name: merchants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.merchants (
    code character varying(40) NOT NULL,
    name character varying(80) NOT NULL,
    plan character varying(60) NOT NULL,
    price numeric(18,2) NOT NULL,
    currency character varying(3) DEFAULT 'COP'::character varying NOT NULL,
    account_id uuid,
    account_number character varying(11),
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscription_charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_charges (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    subscription_id uuid NOT NULL,
    period character varying(7) NOT NULL,
    attempt smallint NOT NULL,
    status character varying(10) NOT NULL,
    reason character varying(200),
    amount numeric(18,2) NOT NULL,
    currency character varying(3) NOT NULL,
    ledger_transaction_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    card_id uuid NOT NULL,
    merchant_code character varying(40) NOT NULL,
    amount numeric(18,2) NOT NULL,
    currency character varying(3) NOT NULL,
    billing_day smallint NOT NULL,
    status character varying(12) NOT NULL,
    pending_period character varying(7) NOT NULL,
    next_charge_date date NOT NULL,
    retry_count smallint DEFAULT '0'::smallint NOT NULL,
    reminded_for character varying(7),
    last_charged_at timestamp with time zone,
    paused_at timestamp with time zone,
    suspended_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: card_settings_audit PK_1da5862b2f425b9e96b9d77279c; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_settings_audit
    ADD CONSTRAINT "PK_1da5862b2f425b9e96b9d77279c" PRIMARY KEY (id);


--
-- Name: subscription_charges PK_3dce185069e15432f367bdc76d8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_charges
    ADD CONSTRAINT "PK_3dce185069e15432f367bdc76d8" PRIMARY KEY (id);


--
-- Name: cards PK_5f3269634705fdff4a9935860fc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cards
    ADD CONSTRAINT "PK_5f3269634705fdff4a9935860fc" PRIMARY KEY (id);


--
-- Name: card_outbox PK_6e466cb6f3b3fe09c8266b379c0; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_outbox
    ADD CONSTRAINT "PK_6e466cb6f3b3fe09c8266b379c0" PRIMARY KEY (id);


--
-- Name: merchants PK_7726488db5747f0daca397ae6fe; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.merchants
    ADD CONSTRAINT "PK_7726488db5747f0daca397ae6fe" PRIMARY KEY (code);


--
-- Name: card_authorizations PK_8240e2f5a7ff8cfc26ee27463aa; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_authorizations
    ADD CONSTRAINT "PK_8240e2f5a7ff8cfc26ee27463aa" PRIMARY KEY (id);


--
-- Name: subscriptions PK_a87248d73155605cf782be9ee5e; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT "PK_a87248d73155605cf782be9ee5e" PRIMARY KEY (id);


--
-- Name: IDX_b2874ef49ff7da2dee49e4bc6d; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_b2874ef49ff7da2dee49e4bc6d" ON public.cards USING btree (account_id);


--
-- Name: idx_card_authorizations_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_authorizations_day ON public.card_authorizations USING btree (card_id, bogota_date);


--
-- Name: idx_card_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_outbox_pending ON public.card_outbox USING btree (published_at, created_at);


--
-- Name: idx_card_settings_audit_card; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_settings_audit_card ON public.card_settings_audit USING btree (card_id, created_at);


--
-- Name: idx_cards_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cards_user ON public.cards USING btree (user_id);


--
-- Name: idx_subscription_charges_sub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscription_charges_sub ON public.subscription_charges USING btree (subscription_id, created_at);


--
-- Name: idx_subscriptions_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_due ON public.subscriptions USING btree (status, next_charge_date);


--
-- Name: idx_subscriptions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_user ON public.subscriptions USING btree (user_id);


--
-- Name: uq_card_authorizations_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_card_authorizations_key ON public.card_authorizations USING btree (idempotency_key) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying])::text[]));


--
-- Name: uq_subscription_charges_paid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_subscription_charges_paid ON public.subscription_charges USING btree (subscription_id, period) WHERE ((status)::text = 'succeeded'::text);


--
-- Name: uq_subscriptions_user_merchant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_subscriptions_user_merchant ON public.subscriptions USING btree (user_id, merchant_code) WHERE ((status)::text <> 'cancelled'::text);


--
-- PostgreSQL database dump complete
--


